/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { AnalyticsServiceSetup, UiSettingsParams } from '@kbn/core/server';
import { CONTEXT_ENGINE_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { WorkflowsManagementOperationPrivileges } from '@kbn/workflows';
import { AiIndexService } from '../ai_indices/service';
import { registerStepDefinitions } from '../step_types';
import { createVerifyKi } from '../step_types/verify_ki';
import { ContextEngineAnalyticsService } from '../telemetry';
import { createPrivilegeChecks } from '../utils/create_privilege_checks';
import { isContextEngineEnabledInSpace } from '../utils/is_context_engine_enabled_in_space';
import { checkContextEngineStep } from './context_engine_workflow_run_checks';

/**
 * The per-space switch every step reads (registered by the Agent Builder SML plugin, whose
 * definition this mirrors for the process: the default is what a space that never set it has).
 */
const contextEngineEnabledSetting: UiSettingsParams<boolean> = {
  name: 'Context Engine',
  type: 'boolean',
  value: false,
  schema: schema.boolean(),
};

/**
 * The Context Engine steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps are registered by the
 * function `plugin.ts` calls (`registerStepDefinitions`), over the same classes: the AI index service
 * over the internal client, the verification service, the analytics service (its events are returned
 * with the run and Kibana reports them), the audit logger of Core's security service and the
 * privilege checks of the security task plugin. The plugin has no config and cannot be disabled, so
 * there are no settings to wait for.
 *
 * Served in a process: `context-engine.createKi`, `updateKi`, `deleteKi` and `verifyKi`.
 *
 * Not registered (a workflow that uses one is declined and Kibana runs it):
 * - `context-engine.getFeedbackContext` and `context-engine.recordImprovements`: they read the
 *   global `contextEngine:feedbackLoop` advanced setting, and a task process has no global ui settings.
 *
 * Declined by a check of the run (`checkContextEngineStep`): a step that names the AI index Agent
 * Builder registers or a templated one (the managed AI indices are in a registry that other plugins
 * populate in `setup()`), and a step with custom verifier workflows (they need the workflows
 * management API to run and cancel them).
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    uiSettings: [{ [CONTEXT_ENGINE_ENABLED_SETTING_ID]: contextEngineEnabledSetting }],
  },
  register: (registry, { host, logger, registerRunCheck }) => {
    const { elasticsearch, savedObjects, uiSettings, security, analytics, plugins } =
      host as TaskHost;
    const securityPlugin = plugins?.security as SecurityTaskPluginStart | undefined;
    if (!securityPlugin) throw new Error('The task process did not get the security plugin');
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');

    const aiIndexLogger = logger.get('context_engine', 'ai_indices');
    const stepsLogger = logger.get('context_engine', 'context_steps');
    const analyticsService = new ContextEngineAnalyticsService(
      // Reports go through the host: the process returns them and Kibana reports them.
      analytics as unknown as AnalyticsServiceSetup,
      logger.get('context_engine', 'telemetry')
    );

    // No registry of managed AI indices: `checkContextEngineStep` declines the steps that need it.
    const aiIndexService = new AiIndexService({
      esClient: elasticsearch.asInternalUser,
      logger: aiIndexLogger,
    });
    const { checkApiPrivileges, checkWritePrivilege } = createPrivilegeChecks({
      getAuthz: async () => securityPlugin.authz as never,
    });
    const isContextEngineEnabled = (spaceId: string) =>
      isContextEngineEnabledInSpace({
        savedObjects,
        uiSettings: uiSettings as never,
        spaceId,
      });
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
    });
  },
};
