/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { AnalyticsServiceSetup, UiSettingsParams } from '@kbn/core/server';
import {
  ATTACK_DISCOVERY_EVENT_ACTIONS,
  ATTACK_DISCOVERY_EVENT_PROVIDER,
} from '@kbn/discoveries/impl/attack_discovery/persistence/event_logging/constants';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createWorkflowsReadApi } from '@kbn/workflows-management-plugin/server/api/workflows_read_api';
import type { WorkflowAccessCore } from '@kbn/workflows-management-plugin/server/services/workflow_access_control';
import { RunStepTypeId } from '../../common/step_types/run_step';
import { registerWorkflowSteps } from '../workflows/register_workflow_steps';
import { createDiscoveriesRunServices } from './create_discoveries_run_services';
import {
  DISCOVERIES_TASK_PROCESS_SETTINGS_ID,
  type DiscoveriesTaskProcessSettings,
} from './discoveries_task_process_settings';

/**
 * The per-space switch the run step reads (registered by the security solution plugin, whose
 * definition this mirrors for the process: the default is what a space that never set it has).
 */
const ENABLE_ATTACK_DISCOVERY_WORKFLOWS_SETTING = 'securitySolution:enableAttackDiscoveryWorkflows';

const workflowsSettingDefinition: UiSettingsParams<boolean> = {
  name: 'Attack Discovery Workflows',
  type: 'boolean',
  value: false,
  schema: schema.boolean(),
};

/**
 * The attack discovery steps in the task process of the workflow task types. Listed under
 * `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The steps are registered by the
 * function `plugin.ts` calls, with the services a process builds from its host in the shape the
 * start contracts have (`createDiscoveriesRunServices`).
 *
 * Served in a process: `defaultAlertRetrieval`, `defaultValidation`, `generate` and `run`. The run
 * step starts its alert retrieval, generation and validation workflows as `workflow:run` tasks
 * (a process serves one run) and polls them, as the scheduled attack discovery executor does.
 *
 * Not registered (a workflow that uses it is declined and Kibana runs it):
 * - `persistDiscoveries`: it writes the alerts with the rule registry's data client, whose service
 *   reads the rule registry and alerting framework configs a workflow process is not sent.
 *
 * Declined by a check of the run: a `run` step that names a `feature_id`, which resolves the
 * inference features other plugins register in their `setup()`.
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [DISCOVERIES_TASK_PROCESS_SETTINGS_ID],
    featureFlags: { [ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG]: true },
    uiSettings: [{ [ENABLE_ATTACK_DISCOVERY_WORKFLOWS_SETTING]: workflowsSettingDefinition }],
    eventLogProviders: [
      {
        provider: ATTACK_DISCOVERY_EVENT_PROVIDER,
        actions: [...ATTACK_DISCOVERY_EVENT_ACTIONS],
      },
    ],
  },
  register: (
    registry,
    { host, logger, services, settings, registerRunCheck, hasStepDefinition }
  ) => {
    if (!services) throw new Error('The workflows task process did not give the engine services');
    const discoveries = settings[DISCOVERIES_TASK_PROCESS_SETTINGS_ID] as
      | DiscoveriesTaskProcessSettings
      | undefined;
    // The plugin is disabled in Kibana, which then sends no settings: nothing to register, and a
    // workflow that uses one of its steps is declined for the missing step.
    if (!discoveries) return;

    const {
      elasticsearch,
      savedObjects,
      uiSettings,
      featureFlags,
      http,
      security,
      userProfile,
      eventLog,
      analytics,
      plugins,
    } = host as TaskHost;
    const securityPlugin = plugins?.security as SecurityTaskPluginStart | undefined;
    if (!securityPlugin) throw new Error('The task process did not get the security plugin');
    if (!uiSettings) throw new Error('The workflows task module did not get ui settings');
    if (!featureFlags) throw new Error('The workflows task module did not get feature flags');
    if (!eventLog) throw new Error('The workflows task module did not get the event log');
    if (!userProfile) {
      throw new Error('The task process host did not lend Core user profile service');
    }
    if (!services.scheduleWorkflow) {
      throw new Error('The workflows task process did not give the engine a scheduler');
    }
    if (!hasStepDefinition) {
      throw new Error('The workflows task process did not give the engine step registry');
    }
    const { scheduleWorkflow } = services;

    const discoveriesLogger = logger.get('discoveries');
    const readApi = createWorkflowsReadApi({
      logger: discoveriesLogger,
      esClient: elasticsearch.asInternalUser,
      core: {
        security,
        userProfile,
        elasticsearch: { client: elasticsearch },
      } as unknown as WorkflowAccessCore,
      authz: securityPlugin.authz as never,
      workflowExecutionsDataClient:
        services.executionDataClients.createWorkflowDataClient() as never,
      stepExecutionsDataClient: services.executionDataClients.createStepDataClient() as never,
    });

    let inference: InferenceServerStart | undefined;
    const { getStartServices, workflowsManagementApi } = createDiscoveriesRunServices({
      core: {
        elasticsearch: { client: elasticsearch },
        featureFlags,
        http: { basePath: http.basePath },
        savedObjects,
        security: { authc: { apiKeys: security.authc.apiKeys } },
        uiSettings,
      },
      authz: securityPlugin.authz as never,
      getActionsClientWithRequest: services.getActionsClientWithRequest as never,
      getInference: () =>
        (inference ??= createInferenceTaskProcessServices({
          core: { elasticsearch, savedObjects, uiSettings },
          logger,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
        })),
      readApi,
      scheduleWorkflow: scheduleWorkflow as never,
      hasStepDefinition,
    });

    const eventLogIndex = eventLog.getIndexPattern?.();
    registerRunCheck?.((step) =>
      step.type === RunStepTypeId && hasFeatureId(step.config)
        ? 'feature_id resolves inference features that other plugins register in Kibana'
        : undefined
    );

    registerWorkflowSteps(registry, {
      analytics: analytics as unknown as AnalyticsServiceSetup,
      connectorTimeout: discoveries.connectorTimeout,
      getEventLogIndex: async () => {
        if (!eventLogIndex) throw new Error('The event log did not say where it writes');
        return eventLogIndex;
      },
      getEventLogger: async () =>
        eventLog.getLogger({ event: { provider: ATTACK_DISCOVERY_EVENT_PROVIDER } }) as never,
      getStartServices,
      langSmithApiKey: discoveries.langSmithApiKey,
      langSmithProject: discoveries.langSmithProject,
      logger: discoveriesLogger,
      workflowsManagementApi,
    });
  },
};

const hasFeatureId = (config: Record<string, unknown>): boolean => {
  const featureId = (config.with as Record<string, unknown> | undefined)?.feature_id;
  return Array.isArray(featureId) ? featureId.length > 0 : Boolean(featureId);
};
