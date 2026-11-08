/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import { kibanaPackageJson } from '@kbn/repo-info';
import type { KibanaRequest, Logger } from '@kbn/core/server';
import { ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID } from '@kbn/elastic-assistant-common/constants';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type {
  RuleTaskTypeModule,
  RuleTypeModuleDeps,
} from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { registerRunFlusher } from '@kbn/task-manager-plugin/server/task_process/run_context';
import { TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS } from '@kbn/task-manager-plugin/server/task_process/host_capabilities/task_scheduling';
import { createSecurityTaskPlugin } from '@kbn/security-plugin/server/task_plugin';
import { createInferenceRunServices } from '@kbn/inference-plugin/server/run_services';
import { configSchema as inferenceConfigSchema } from '@kbn/inference-plugin/server/config';
import {
  createPlainIndexDataClients,
  getWorkflowDataStreamDefinitions,
  initializeDataStreamDataClients,
  createWorkflowScheduler,
  WORKFLOWS_EXECUTION_ENGINE_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/workflows-execution-engine/server';
import type { WorkflowsExecutionEngineConfig } from '@kbn/workflows-execution-engine/server';
import {
  createWorkflowsReadApi,
  scheduleWorkflowWithEngine,
} from '@kbn/workflows-management-plugin/server';
import type { WorkflowAccessCore } from '@kbn/workflows-management-plugin/server';
import {
  ATTACK_DISCOVERY_EVENT_ACTIONS,
  ATTACK_DISCOVERY_EVENT_PROVIDER,
  ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS,
} from '@kbn/discoveries';
import type { AttackDiscoveryWorkflowExecutorContribution } from '@kbn/discoveries';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import { promptType } from '@kbn/security-ai-prompts';
import { getAttackDiscoveryScheduleType } from '../lib/attack_discovery/schedules/register_schedule/definition';
import type { AttackDiscoveryWorkflowExecutorFactory } from '../types';

/** The task manager settings that decide which API key a scheduled task is granted. */
const TASK_MANAGER_SETTINGS_ID = 'taskManager';
/** The security plugin registers its settings under its own id. */
const SECURITY_PLUGIN_ID = 'security';

const kibanaOnly = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/** `server.publicBaseUrl` includes the base path, which is what Core's `basePath.get` returns. */
const getBasePath = (publicBaseUrl?: string): string => {
  if (!publicBaseUrl) return '';
  try {
    return new URL(publicBaseUrl).pathname.replace(/\/$/, '');
  } catch (error) {
    return '';
  }
};

/** What the module reads of the host besides `TaskHost`: the services Core owns that a process lends it. */
type RunHost = TaskHost & {
  /** Core's user profile service: needed when a workflow is private to its owner. */
  userProfile?: WorkflowAccessCore['userProfile'];
};

const getInference = (deps: RuleTypeModuleDeps) => {
  const { host, runtime } = deps;
  return createInferenceRunServices({
    // The connector of the rule is resolved with the actions client of the rule run.
    actions: runtime.actionsPlugin,
    esClient: host.elasticsearch.asInternalUser,
    logger: deps.logger,
    // A bundle has no worker file for the pool: anonymization runs in the process.
    // The pool is the only thing the inference config decides here, so its defaults are all it needs.
    config: inferenceConfigSchema.validate({ workers: { anonymization: { enabled: false } } }),
  });
};

const createWorkflowDataClientsFromHost = async (
  host: Pick<TaskHost, 'dataStreams' | 'onRunEnd' | 'elasticsearch'>,
  engineConfig: Pick<WorkflowsExecutionEngineConfig, 'storage'>,
  logger: Logger
): Promise<ReturnType<typeof createPlainIndexDataClients>> => {
  const esClient = host.elasticsearch.asInternalUser;
  if (engineConfig.storage.source === 'plain_index') {
    return createPlainIndexDataClients({ esClient, logger });
  }
  const { dataStreams, onRunEnd } = host;
  if (!dataStreams || !onRunEnd) {
    throw new Error('Native workflow data streams require Core data streams and run cleanup');
  }
  const clients = await initializeDataStreamDataClients({ esClient, logger, dataStreams });
  const stop = async () => clients.stop();
  if (!registerRunFlusher(stop)) onRunEnd(stop);
  return {
    workflowExecutionsDataClient: clients.createWorkflowDataClient(),
    stepExecutionsDataClient: clients.createStepDataClient(),
  };
};

/**
 * The executor of the rules that carry a `workflowConfig`, built from the host the way the
 * discoveries plugin builds it from its start contracts. Workflows are only scheduled here: their
 * steps run under a `workflow:run` task that carries a clone of the rule's API key.
 */
const getWorkflowExecutorFactory = (
  deps: RuleTypeModuleDeps
): AttackDiscoveryWorkflowExecutorFactory => {
  const host = deps.host as RunHost;
  const { logger } = deps;

  return async (options) => {
    const { featureFlags, taskManager, userProfile, licensing } = host;
    // The executor is the one the discoveries plugin builds for Kibana, which it contributes to this process.
    const contribution = host.contributions?.[
      ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS
    ]?.[0] as AttackDiscoveryWorkflowExecutorContribution | undefined;
    if (!contribution) {
      throw new Error(
        'The discoveries plugin did not contribute the attack discovery workflow executor'
      );
    }
    const security = host.plugins?.security as
      | { authz: Parameters<typeof createWorkflowsReadApi>[0]['authz'] }
      | undefined;
    if (!featureFlags) throw new Error('The attack discovery module did not get feature flags');
    if (!taskManager) throw new Error('The attack discovery module did not get task scheduling');
    if (!licensing) throw new Error('The attack discovery module did not get the license');
    if (!security?.authz) {
      throw new Error(
        'The attack discovery module needs the security task plugin (host.plugins.security)'
      );
    }
    if (!userProfile) {
      throw new Error(
        'The task process host did not lend Core user profile service (host.userProfile)'
      );
    }
    const engineConfig = deps.settings[
      WORKFLOWS_EXECUTION_ENGINE_TASK_PROCESS_SETTINGS_ID
    ] as WorkflowsExecutionEngineConfig;
    if (!engineConfig) throw new Error('The attack discovery module did not get workflow settings');
    const esClient = host.elasticsearch.asInternalUser;
    const dataClients = await createWorkflowDataClientsFromHost(host, engineConfig, logger);
    const core = {
      security: host.security,
      userProfile,
      elasticsearch: { client: host.elasticsearch },
    };
    const readApi = createWorkflowsReadApi({
      logger,
      esClient,
      core,
      authz: security.authz,
      ...dataClients,
    });

    const scheduler = createWorkflowScheduler({
      taskManager,
      esClient,
      security: host.security,
      userProfile,
      elasticsearch: host.elasticsearch,
      licensing: { getLicense: () => firstValueFrom(licensing.license$) },
      logger,
      config: engineConfig,
      ...dataClients,
      kibanaUrlSource: { http: { basePath: { publicBaseUrl: deps.publicBaseUrl } } },
    });

    const workflowsManagementApi: WorkflowsManagementApi = {
      getWorkflow: readApi.getWorkflow,
      getWorkflowExecution: readApi.getWorkflowExecution,
      scheduleWorkflow: (workflow, spaceId, inputs, request, triggeredBy) =>
        scheduleWorkflowWithEngine({
          scheduleWorkflow: scheduler.scheduleWorkflow,
          workflow,
          spaceId,
          inputs,
          request,
          triggeredBy,
        }),
      // The scheduled run always schedules (see `wrapManagementApiForScheduledExecution`).
      runWorkflow: kibanaOnly('Running a workflow inline') as never,
    };

    // The step registry of the workflows extensions lives in Kibana: the steps are the ones the
    // discoveries plugin registers when the feature flag is on.
    // oxlint-disable-next-line @kbn/eslint/no_feature_flag_snapshot -- this runs once per rule run, which is when the flag is evaluated and sent
    const workflowsEnabled = await firstValueFrom(
      featureFlags.getBooleanValue$(ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG, true)
    );
    const basePath = getBasePath(deps.publicBaseUrl);
    const { eventLog } = host;
    if (!eventLog) throw new Error('The attack discovery module did not get the event log');
    const eventLogIndex = eventLog.getIndexPattern?.();

    return contribution.createWorkflowExecutor({
      analytics: host.analytics as never,
      apiKeys: host.security.authc.apiKeys,
      authz: security.authz as never,
      basePath: { get: () => basePath },
      elasticsearch: host.elasticsearch,
      featureFlags,
      getEventLogIndex: async () => {
        if (!eventLogIndex) throw new Error('The event log did not say where it writes');
        return eventLogIndex;
      },
      getEventLogger: async () =>
        eventLog.getLogger({ event: { provider: ATTACK_DISCOVERY_EVENT_PROVIDER } }) as never,
      getSpaceId: (request: KibanaRequest) => request.spaceId ?? 'default',
      inference: getInference(deps),
      logger,
      publicBaseUrl: deps.publicBaseUrl,
      workflowsExtensions: {
        hasStepDefinition: (id: string) => workflowsEnabled && contribution.stepTypeIds.has(id),
        initManagedWorkflowsClient: async (pluginId: string) =>
          ({
            getWorkflowStatus: (id: never, statusOptions: never) =>
              readApi.getManagedWorkflowStatus(id, statusOptions, pluginId),
          } as never),
      },
      workflowsManagementApi,
    })(options);
  };
};

/**
 * The seam has no option for the feature flags a module reads yet, and the rule type module has the
 * contribution key of the discoveries plugin to add: copies the descriptors, which keeps the getters.
 */
const withFeatureFlagsAndContribution = (module: RuleTaskTypeModule): RuleTaskTypeModule => {
  const extended = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(module)
  ) as RuleTaskTypeModule;
  Object.defineProperty(extended, 'featureFlags', {
    enumerable: true,
    configurable: true,
    writable: true,
    // Next to the flags the contributions of other plugins declare.
    value: { ...module.featureFlags, [ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG]: true },
  });
  if (module.contributions) {
    const { apply } = module.contributions;
    extended.contributions = {
      ...module.contributions,
      keys: [
        ...new Set([
          ...module.contributions.keys,
          ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS,
        ]),
      ],
      apply: apply
        ? (contributed) => withFeatureFlagsAndContribution(apply(contributed) as RuleTaskTypeModule)
        : undefined,
    };
  }
  return extended;
};

/**
 * The attack discovery rule type, which a task process can run. The legacy path calls the model of the
 * rule's connector through the actions executor; the workflow path schedules the workflows, whose
 * steps run as workflow tasks.
 */
export const taskType = withFeatureFlagsAndContribution(
  createRuleTaskType(
    {
      ruleTypeId: ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID,
      getRuleType: (deps) =>
        getAttackDiscoveryScheduleType({
          // Both are built when a rule runs, not when the rule type is built: the runtime of the run
          // and the host members are not used before that.
          getInference: (() => {
            let inference: ReturnType<typeof getInference> | undefined;
            return () => (inference ??= getInference(deps));
          })(),
          getWorkflowExecutorFactory: (() => {
            let factory: AttackDiscoveryWorkflowExecutorFactory | undefined;
            return () => (factory ??= getWorkflowExecutorFactory(deps));
          })(),
          logger: deps.logger,
          publicBaseUrl: deps.publicBaseUrl,
          telemetry: deps.host?.analytics as never,
        }) as never,
    },
    {
      // The connector of the rule is executed with the actions executor of the process.
      executeConnectors: true,
      createDataStreams: (settings) => {
        const engineConfig = settings[
          WORKFLOWS_EXECUTION_ENGINE_TASK_PROCESS_SETTINGS_ID
        ] as WorkflowsExecutionEngineConfig;
        if (!engineConfig)
          throw new Error('The attack discovery module did not get workflow settings');
        return Object.values(getWorkflowDataStreamDefinitions(engineConfig.storage));
      },
      // The attack discovery event log provider, and the encrypted `task` type its workflow tasks use.
      eventLogProviders: [
        {
          provider: ATTACK_DISCOVERY_EVENT_PROVIDER,
          actions: [...ATTACK_DISCOVERY_EVENT_ACTIONS],
        },
      ],
      encryptedSavedObjectTypes: TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS,
      // Read from host.settings: registered with alerting.registerTaskProcessSettings by their owners.
      settings: [
        WORKFLOWS_EXECUTION_ENGINE_TASK_PROCESS_SETTINGS_ID,
        SECURITY_PLUGIN_ID,
        TASK_MANAGER_SETTINGS_ID,
      ],
      // Prompts are read from saved objects.
      savedObjectTypes: [promptType],
      // The workflow tasks carry the API key cloned by the native scheduler.
      schedulableTaskTypes: [/^workflow:run$/],
      // Privilege checks and the API key clone come from the security plugin's task plugin.
      taskPlugins: [createSecurityTaskPlugin(kibanaPackageJson.version)],
    }
  )
);
