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
import {
  ATTACK_DISCOVERY_MISCONFIGURATION_EVENT,
  ATTACK_DISCOVERY_SCHEDULE_ACTION_EVENT,
  ATTACK_DISCOVERY_STEP_FAILURE_EVENT,
} from '@kbn/discoveries/impl/lib/telemetry/event_based_telemetry';
import { createInferenceTaskProcessServices } from '@kbn/inference-plugin/server/task_process_services';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import { createSearchInferenceEndpointsStart } from '@kbn/search-inference-endpoints/server/create_search_inference_endpoints_start';
import {
  createTaskProcessInferenceFeatureRegistry,
  INFERENCE_FEATURES_TASK_PROCESS_SETTINGS_ID,
  type InferenceFeaturesTaskProcessSettings,
} from '@kbn/search-inference-endpoints/server/task_process_settings';
import { createWorkflowRuleDataService } from '@kbn/rule-registry-plugin/server/task_types/workflow_rule_data_services';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createWorkflowsReadApi } from '@kbn/workflows-management-plugin/server/api/workflows_read_api';
import type { WorkflowAccessCore } from '@kbn/workflows-management-plugin/server/services/workflow_access_control';
import { getAttackDiscoveryIndexOptions } from '../lib/attack_discovery/index_options';
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
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [
      DISCOVERIES_TASK_PROCESS_SETTINGS_ID,
      INFERENCE_FEATURES_TASK_PROCESS_SETTINGS_ID,
      'ruleRegistry',
      'alerting',
    ],
    featureFlags: { [ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG]: true },
    uiSettings: [{ [ENABLE_ATTACK_DISCOVERY_WORKFLOWS_SETTING]: workflowsSettingDefinition }],
    // The events the steps report; the process ships them itself.
    analyticsEventTypes: [
      ATTACK_DISCOVERY_MISCONFIGURATION_EVENT,
      ATTACK_DISCOVERY_SCHEDULE_ACTION_EVENT,
      ATTACK_DISCOVERY_STEP_FAILURE_EVENT,
    ],
    eventLogProviders: [
      {
        provider: ATTACK_DISCOVERY_EVENT_PROVIDER,
        actions: [...ATTACK_DISCOVERY_EVENT_ACTIONS],
      },
    ],
  },
  register: async (registry, { host, logger, services, settings, hasStepDefinition }) => {
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
    let searchInferenceEndpoints: SearchInferenceEndpointsPluginStart | undefined;
    const inferenceCore = { elasticsearch, savedObjects, uiSettings };
    const getInference = (): InferenceServerStart =>
      (inference ??= createInferenceTaskProcessServices({
        core: inferenceCore,
        logger,
        getActionsClientWithRequest: services.getActionsClientWithRequest,
      }));
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
      getInference,
      getSearchInferenceEndpoints: () =>
        (searchInferenceEndpoints ??= createSearchInferenceEndpointsStart({
          core: inferenceCore,
          inference: getInference(),
          featureRegistry: createTaskProcessInferenceFeatureRegistry(
            settings[INFERENCE_FEATURES_TASK_PROCESS_SETTINGS_ID] as
              | InferenceFeaturesTaskProcessSettings
              | undefined,
            discoveriesLogger.get('inferenceFeatures')
          ),
          logger: discoveriesLogger.get('searchInferenceEndpoints'),
        })),
      readApi,
      scheduleWorkflow: scheduleWorkflow as never,
      hasStepDefinition,
    });

    const eventLogIndex = eventLog.getIndexPattern?.();

    const ruleDataService = await createWorkflowRuleDataService(host as TaskHost);
    registerWorkflowSteps(registry, {
      adhocAttackDiscoveryDataClient: ruleDataService.initializeIndex(
        getAttackDiscoveryIndexOptions()
      ),
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
