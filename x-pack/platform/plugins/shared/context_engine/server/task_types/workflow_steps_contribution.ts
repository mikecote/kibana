/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup } from '@kbn/core/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { WorkflowsManagementOperationPrivileges } from '@kbn/workflows';
import { createContextEngineRunServices } from '../run_services/create_context_engine_run_services';
import { CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID } from '../../common/constants';
import { registerStepDefinitions } from '../step_types';
import { createVerifyKi } from '../step_types/verify_ki';
import { ContextEngineAnalyticsService } from '../telemetry';
import { contextEngineServerEbtEvents } from '../telemetry/events';
import { createPrivilegeChecks } from '../utils/create_privilege_checks';
import { isContextEngineEnabledInSpace } from '../utils/is_context_engine_enabled_in_space';
import { contextEngineGlobalUiSettings, contextEngineSpaceUiSettings } from '../ui_settings';
import { checkContextEngineStep } from './context_engine_workflow_run_checks';
import {
  CONTEXT_ENGINE_MANAGED_INDICES_SETTINGS_ID,
  createTaskProcessAiIndexRegistry,
  type ContextEngineManagedIndicesSettings,
} from './task_process_settings';

/**
 * The Context Engine steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps are registered by the
 * function `plugin.ts` calls (`registerStepDefinitions`), over the same classes: the AI index service
 * over the internal client, the verification service, the analytics service (its events are shipped
 * by the process, which registers their types), the audit logger of Core's security service and the
 * privilege checks of the security task plugin. The plugin has no config and cannot be disabled, so
 * there are no settings to wait for.
 *
 * The KI and feedback steps use the same services and space/global settings as Kibana.
 *
 * Managed AI indices are restored from Kibana's dispatch snapshot. Custom verifier workflows still
 * require the workflow management API to run and cancel them.
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    uiSettings: [contextEngineSpaceUiSettings],
    globalUiSettings: [contextEngineGlobalUiSettings],
    settings: [CONTEXT_ENGINE_MANAGED_INDICES_SETTINGS_ID],
    // The events of the analytics service; the process ships them itself.
    analyticsEventTypes: contextEngineServerEbtEvents,
  },
  register: (registry, { host, logger, registerRunCheck, settings }) => {
    const { elasticsearch, savedObjects, uiSettings, security, analytics, plugins } =
      host as TaskHost;
    const securityPlugin = plugins?.security as SecurityTaskPluginStart | undefined;
    if (!securityPlugin) throw new Error('The task process did not get the security plugin');
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    const aiIndexLogger = logger.get('context_engine', 'ai_indices');
    const stepsLogger = logger.get('context_engine', 'context_steps');
    const analyticsService = new ContextEngineAnalyticsService(
      // Reports go through the host: the process ships them itself before it answers.
      analytics as unknown as AnalyticsServiceSetup,
      logger.get('context_engine', 'telemetry')
    );

    const runServices = createContextEngineRunServices({
      esClient: elasticsearch.asInternalUser,
      logger: aiIndexLogger,
      savedObjects,
      uiSettings,
      audit: security.audit,
      getSpaceId: (request) => (request as { spaceId?: string }).spaceId ?? 'default',
      managedAiIndices: createTaskProcessAiIndexRegistry(
        settings[CONTEXT_ENGINE_MANAGED_INDICES_SETTINGS_ID] as
          | ContextEngineManagedIndicesSettings
          | undefined
      ),
    });
    const { aiIndexService } = runServices;
    const { checkApiPrivileges, checkWritePrivilege } = createPrivilegeChecks({
      getAuthz: async () => securityPlugin.authz as never,
    });
    const isContextEngineEnabled = (spaceId: string) =>
      isContextEngineEnabledInSpace({
        savedObjects,
        uiSettings: uiSettings as never,
        spaceId,
      });
    const isFeedbackLoopEnabled = async () =>
      (await uiSettings
        .globalAsScopedToClient(savedObjects.createInternalRepository())
        .get<boolean>(CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID)) ?? false;
    const verifyKi = createVerifyKi({
      getAuditLogger: async (request) => security.audit.asScoped(request),
      // Custom verifier workflows are declined by `checkContextEngineStep`.
      workflowVerifierDeps: {
        getWorkflowsManagement: async () => undefined,
        checkExecutePrivilege: (request, spaceId) =>
          checkApiPrivileges(request, spaceId, WorkflowsManagementOperationPrivileges.execute),
      },
      analyticsService,
      logger: stepsLogger,
    });

    registerRunCheck?.(checkContextEngineStep);
    registerStepDefinitions({
      workflowsExtensions: registry,
      analyticsService,
      logger: stepsLogger,
      getAiIndexService: () => aiIndexService,
      isContextEngineEnabled,
      checkWritePrivilege,
      verifyKi,
      feedbackAnalysis: {
        getAiIndexService: () => aiIndexService,
        getImprovementsService: runServices.getImprovementsService,
        getAuditLogger: async (request) => security.audit.asScoped(request),
        isContextEngineEnabled,
        isFeedbackLoopEnabled,
        checkWritePrivilege,
        logger: logger.get('feedback_analysis'),
      },
    });
  },
};
