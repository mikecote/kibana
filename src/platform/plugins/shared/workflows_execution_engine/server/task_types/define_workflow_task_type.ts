/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  EVENT_LOG_ACTIONS as ACTIONS_EVENT_LOG_ACTIONS,
  EVENT_LOG_PROVIDER as ACTIONS_EVENT_LOG_PROVIDER,
} from '@kbn/actions-plugin/server/constants/event_log';
import { getRuleRunDeclarations } from '@kbn/alerting-plugin/server/task_types/rule_run_saved_object_types';
import { createStandaloneEventLog } from '@kbn/event-log-plugin/server/standalone_event_log';
import { kibanaPackageJson } from '@kbn/repo-info';
import { createSecurityTaskPlugin } from '@kbn/security-plugin/server/task_plugin';
import { TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS } from '@kbn/task-manager-plugin/server/task_process/host_capabilities/task_scheduling';
import type { TaskHost, TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';
import { defineTaskType } from '@kbn/task-manager-plugin/server/task_type_module';
import { WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG } from '@kbn/workflows';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import {
  RULE_RUN_CONTRIBUTIONS_KEY,
  WORKFLOW_STEPS_CONTRIBUTIONS_KEY,
  WORKFLOWS_ENGINE_CLOUD_SETTINGS_ID,
  WORKFLOWS_ENGINE_SETTINGS_ID,
} from './constants';
import type { WorkflowRuntime, WorkflowTaskFunction } from '../create_workflow_runtime';
import { createWorkflowsEngineTaskPlugin } from '../task_plugin';

/** The id of the engine's plugin, which a module reads the runtime of as `host.plugins[id]`. */
export const WORKFLOWS_ENGINE_PLUGIN_ID = 'workflowsExecutionEngine';

/** What the engine's task plugin (or, in Kibana, the plugin) hands a module as `host.plugins.workflowsExecutionEngine`. */
export interface WorkflowsEngineHostPlugin {
  /** Kibana: the runtime of the plugin. A process builds its own from the host. */
  runtime?: WorkflowRuntime;
}

// The connectors and their task params, and `alert`, which the actions client reads rule actions from.
const ACTION_SAVED_OBJECT_TYPES = new Set(['action', 'action_task_params', 'alert']);

let processRuntime: Promise<{ runtime: WorkflowRuntime; stop: () => void }> | undefined;

/**
 * The runtime a run uses: the plugin's in Kibana, built once per process from the host in a task
 * process (a process serves one run, so what it builds is released with it).
 */
const getRuntime = async (host: TaskHost): Promise<WorkflowRuntime> => {
  const plugin = host.plugins?.[WORKFLOWS_ENGINE_PLUGIN_ID] as
    | WorkflowsEngineHostPlugin
    | undefined;
  if (plugin?.runtime) return plugin.runtime;
  // Loaded here so that Kibana, which never gets here, does not load it.
  const { createWorkflowRuntimeFromHost } = await import('./process_runtime');
  processRuntime ??= createWorkflowRuntimeFromHost(host);
  return (await processRuntime).runtime;
};

/**
 * One of the three workflow task types as a module. What it declares is what a process needs and
 * Kibana already has: the same module is registered in Kibana (whose plugin hands over its runtime)
 * and bundled for the task process (which builds a runtime from its host).
 */
export const defineWorkflowTaskType = (
  definition: Pick<
    TaskTypeModule,
    | 'type'
    | 'title'
    | 'description'
    | 'timeout'
    | 'maxAttempts'
    | 'paramsSchema'
    | 'allowPriorityOverride'
  >,
  pick: (runtime: WorkflowRuntime) => WorkflowTaskFunction,
  stepContributions: WorkflowStepsContribution[] = []
): TaskTypeModule => {
  const declared = stepContributions.map((contribution) => contribution.declares ?? {});
  const taskType = defineTaskType({
    ...definition,
    // Reads and schedules the `workflow:*` tasks (and the `actions:*` tasks that run connectors).
    taskManager: { schedulableTypes: [/^workflow:/, /^actions:/] },
    licensing: true,
    featureFlags: Object.assign(
      { [WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG]: false },
      ...declared.map(({ featureFlags }) => featureFlags ?? {})
    ),
    eventLog: {
      providers: [
        { provider: ACTIONS_EVENT_LOG_PROVIDER, actions: Object.values(ACTIONS_EVENT_LOG_ACTIONS) },
      ],
      create: createStandaloneEventLog,
    },
    // The config of the engine and its cloud fields, the security and actions configs the services
    // it uses are built from, and what decides which API key a scheduled task is granted.
    settings: [
      WORKFLOWS_ENGINE_SETTINGS_ID,
      WORKFLOWS_ENGINE_CLOUD_SETTINGS_ID,
      'security',
      'actions',
      'taskManager',
      ...new Set(declared.flatMap(({ settings }) => settings ?? [])),
    ],
    // Only when contributions declare some: it gives the runner `host.uiSettings`.
    ...(declared.some(({ uiSettings }) => uiSettings?.length)
      ? { uiSettings: { defaults: declared.flatMap(({ uiSettings }) => uiSettings ?? []) } }
      : {}),
    // `alerting-rule-run`: the connector types of the plugins that own them. `workflow-steps`: the
    // steps and triggers of the plugins that register them.
    contributions: {
      keys: [RULE_RUN_CONTRIBUTIONS_KEY, WORKFLOW_STEPS_CONTRIBUTIONS_KEY],
      // A task process hands over what plugins contribute; the module is built again with it.
      apply: (contributed) =>
        defineWorkflowTaskType(
          definition,
          pick,
          (contributed[WORKFLOW_STEPS_CONTRIBUTIONS_KEY] ?? []) as WorkflowStepsContribution[]
        ),
    },
    taskPlugins: [
      createSecurityTaskPlugin(kibanaPackageJson.version),
      createWorkflowsEngineTaskPlugin(kibanaPackageJson.version),
    ],
    createTaskRunner: (context, host) => {
      const runner = getRuntime(host).then((runtime) => pick(runtime)(context));
      return {
        run: async () => (await runner).run(),
        cancel: async () => (await runner).cancel?.(),
        cleanup: async () => {
          await processRuntime?.then(({ stop }) => stop());
        },
      };
    },
  });
  // The saved object types and encrypted registrations are built from the code of the actions plugin,
  // which costs something, so only when a task process reads them.
  let declarations: ReturnType<typeof getRuleRunDeclarations> | undefined;
  const getDeclarations = () => (declarations ??= getRuleRunDeclarations());
  return Object.defineProperties(taskType, {
    savedObjectTypes: {
      enumerable: true,
      get: () =>
        getDeclarations()
          .savedObjectTypes.filter((type) => ACTION_SAVED_OBJECT_TYPES.has(type.name))
          .concat(declared.flatMap(({ savedObjectTypes }) => savedObjectTypes ?? [])),
    },
    encryptedSavedObjectTypes: {
      enumerable: true,
      get: () => [
        ...getDeclarations().encryptedSavedObjectTypes.filter((registration) =>
          ACTION_SAVED_OBJECT_TYPES.has(registration.type)
        ),
        ...TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS,
        ...declared.flatMap(({ encryptedSavedObjectTypes }) => encryptedSavedObjectTypes ?? []),
      ],
    },
  });
};
