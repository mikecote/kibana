/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { coreMock } from '@kbn/core/server/mocks';
import type { EncryptedSavedObjectsPluginSetup } from '@kbn/encrypted-saved-objects-plugin/server';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { TaskTypeGroup } from '@kbn/task-manager-plugin/server/task';
import {
  createHostFeatureFlags,
  runInRunContext,
} from '@kbn/task-manager-plugin/server/task_process/run_context';
import { WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG } from '@kbn/workflows';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createWorkflowRuntimeFromHost } from './process_runtime';
import { taskType as resumeTaskType } from './workflow_resume.task';
import { taskType as runTaskType } from './workflow_run.task';
import { taskType as scheduledTaskType } from './workflow_scheduled.task';

jest.mock('./process_runtime', () => ({ createWorkflowRuntimeFromHost: jest.fn() }));

describe('workflow task type modules', () => {
  const modules = [runTaskType, resumeTaskType, scheduledTaskType];

  it('keep the definitions the plugin registered', () => {
    expect(
      modules.map(({ type, title, timeout, maxAttempts, allowPriorityOverride }) => ({
        type,
        title,
        timeout,
        maxAttempts,
        allowPriorityOverride,
      }))
    ).toEqual([
      {
        type: 'workflow:run',
        title: 'Run Workflow',
        timeout: '365d',
        maxAttempts: 3,
        allowPriorityOverride: undefined,
      },
      {
        type: 'workflow:resume',
        title: 'Resume Workflow',
        timeout: '365d',
        maxAttempts: 3,
        allowPriorityOverride: true,
      },
      {
        type: 'workflow:scheduled',
        title: 'Scheduled Workflow Execution',
        timeout: '365d',
        maxAttempts: 3,
        allowPriorityOverride: undefined,
      },
    ]);
    expect(resumeTaskType.paramsSchema).toBeDefined();
    expect(modules.every((module) => module.taskTypeGroup !== TaskTypeGroup.Alerting)).toBe(true);
  });

  it.each(modules.map((module) => [module.type, module] as const))(
    'declares what the process of %s needs',
    (_type, module) => {
      expect(module.taskManager).toEqual({ schedulableTypes: [/^workflow:/, /^actions:/] });
      expect(module.cancelGracePeriodMs).toBe(5000);
      expect(module.licensing).toBe(true);
      expect(Object.keys(module.featureFlags ?? {})).toEqual([
        WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG,
      ]);
      expect(module.settings).toEqual(
        expect.arrayContaining([
          'workflowsExecutionEngine',
          'workflowsExecutionEngineCloud',
          'security',
          'actions',
          'taskManager',
        ])
      );
      expect(module.contributions?.keys).toEqual([
        'alerting-rule-run',
        'workflow-steps',
        'agent-builder',
      ]);
      expect(module.taskPlugins?.map(({ manifest }) => manifest.id)).toEqual([
        'security',
        'telemetry',
        'workflowsExecutionEngine',
      ]);
      expect(module.usageCounters).toBe(true);
      // The event types a run reports must be registered in the process.
      expect(module.analyticsEventTypes?.map(({ eventType }) => eventType)).toEqual(
        expect.arrayContaining(['workflows_execution_workflow_completed'])
      );
      expect(module.encryptedSavedObjectTypes?.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['action', 'action_task_params', 'task'])
      );
      expect(module.savedObjectTypes?.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['action', 'action_task_params'])
      );
    }
  );

  it('runs the runtime of the plugin when Kibana hands it over', async () => {
    const run = jest.fn().mockResolvedValue({ state: {} });
    const cancel = jest.fn();
    const runWorkflowTask = jest.fn(() => ({ run, cancel }));
    const context = { taskInstance: {}, signal: new AbortController().signal } as never;
    const runner = runTaskType.createTaskRunner(context, {
      plugins: { workflowsExecutionEngine: { runtime: { runWorkflowTask } } },
    } as never);

    await expect(runner.run()).resolves.toEqual({ state: {} });
    await runner.cancel?.();
    expect(runWorkflowTask).toHaveBeenCalledWith(context);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('workflow task type modules with contributions', () => {
  const contribution = {
    declares: {
      savedObjectTypes: [{ name: 'contributed-type' }],
      encryptedSavedObjectTypes: [
        { type: 'contributed-encrypted', attributesToEncrypt: new Set() },
      ],
      dataStreams: [
        {
          name: '.contributed-data',
          version: 1,
          template: { mappings: { properties: { '@timestamp': { type: 'date' as const } } } },
        },
      ],
      settings: ['contributedPlugin'],
      uiSettings: [{ 'contributed:setting': { schema: {}, value: 1 } }],
      featureFlags: { 'contributed.flag': true },
    },
    register: () => {},
  };

  it.each([runTaskType, resumeTaskType, scheduledTaskType].map((m) => [m.type, m] as const))(
    'merges what the contributions of %s declare',
    (_type, module) => {
      expect(module.contributions?.keys).toContain('workflow-steps');
      const applied = module.contributions!.apply!({
        'workflow-steps': [contribution, {}],
      } as never);
      expect(applied.type).toBe(module.type);
      expect(applied.savedObjectTypes?.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['action', 'contributed-type'])
      );
      expect(applied.encryptedSavedObjectTypes?.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['action', 'task', 'contributed-encrypted'])
      );
      // The engine's own settings are required; what a contribution reads is optional, because a
      // disabled plugin sends nothing and its contribution then registers nothing.
      expect(applied.settings).toEqual(expect.arrayContaining(['security']));
      expect(applied.settings).not.toContain('contributedPlugin');
      expect(applied.optionalSettings).toEqual(['contributedPlugin']);
      expect(applied.uiSettings?.defaults).toEqual(contribution.declares.uiSettings);
      expect(applied.dataStreams).toEqual(contribution.declares.dataStreams);
      expect(applied.featureFlags).toEqual({
        [WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG]: false,
        'contributed.flag': true,
      });
      // Without declarations nothing is added.
      expect(module.uiSettings).toBeUndefined();
      expect(module.settings).not.toContain('contributedPlugin');
    }
  );
});

describe('workflow native analytics registrations', () => {
  it('combines typed schemas declared by workflow steps and Agent Builder contributions', () => {
    const steps: WorkflowStepsContribution = {
      declares: {
        registerAnalyticsEventTypes: (analytics) =>
          analytics.registerEventType({ eventType: 'step.event', schema: {} }),
      },
      register: () => {},
    };
    const agents: AgentBuilderContribution = {
      declares: {
        registerAnalyticsEventTypes: (analytics) =>
          analytics.registerEventType({ eventType: 'agent.event', schema: {} }),
      },
      register: () => {},
    };
    const applied = runTaskType.contributions?.apply?.({
      'workflow-steps': [steps],
      'agent-builder': [agents],
    });
    if (!applied?.registerAnalyticsEventTypes)
      throw new Error('Native analytics registrations were lost');
    const { analytics } = coreMock.createSetup();
    applied.registerAnalyticsEventTypes(analytics);
    expect(analytics.registerEventType.mock.calls.map(([event]) => event.eventType)).toEqual([
      'step.event',
      'agent.event',
    ]);
  });
});

describe('workflow process runtime lifecycle', () => {
  const createRuntime = jest.mocked(createWorkflowRuntimeFromHost);
  beforeEach(() => createRuntime.mockReset());

  it('creates and stops fresh services for each execution inside its run context', async () => {
    const flags = createHostFeatureFlags();
    const stop = jest.fn();
    const runWorkflowTask = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    const initialized: boolean[] = [];
    createRuntime.mockImplementation(async () => {
      initialized.push(await firstValueFrom(flags.getBooleanValue$('test.flag', false)));
      return { runtime: { runWorkflowTask } as never, stop };
    });
    const host = {} as never;
    for (const enabled of [true, false]) {
      const context = { taskInstance: {}, signal: new AbortController().signal } as never;
      const runner = runTaskType.createTaskRunner(context, host);
      const before = createRuntime.mock.calls.length;
      expect(before).toBe(initialized.length);
      const result = await runInRunContext(async () => runner.run(), {
        featureFlags: { 'test.flag': enabled },
      });
      expect(result).toEqual({ value: { state: {} } });
      await runner.cleanup?.();
    }
    expect(initialized).toEqual([true, false]);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('does not initialize workflow services for an aborted execution', async () => {
    const controller = new AbortController();
    const context = { taskInstance: {}, signal: controller.signal } as never;
    const runner = runTaskType.createTaskRunner(context, {} as never);
    controller.abort();
    await expect(runner.run()).rejects.toHaveProperty('name', 'AbortError');
    await runner.cleanup?.();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('stops execution services even when runner cleanup fails', async () => {
    const stop = jest.fn();
    createRuntime.mockResolvedValue({
      runtime: {
        runWorkflowTask: () => ({
          run: async () => ({ state: {} }),
          cleanup: async () => {
            throw new Error('cleanup failed');
          },
        }),
      } as never,
      stop,
    });
    const runner = runTaskType.createTaskRunner(
      { signal: new AbortController().signal } as never,
      {} as never
    );
    await runner.run();
    await expect(runner.cleanup?.()).rejects.toThrow('cleanup failed');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('workflow native encrypted migration factories', () => {
  it('passes the same native encryption setup to every contributing saved object factory', () => {
    const createSavedObjectTypes = jest.fn(
      (encryption: Pick<EncryptedSavedObjectsPluginSetup, 'createMigration'>) => {
        expect(encryption).toBe(nativeEncryption);
        return [
          {
            name: 'native-migrated-type',
            hidden: false,
            namespaceType: 'single' as const,
            mappings: { properties: {} },
          },
        ];
      }
    );
    const nativeEncryption = encryptedSavedObjectsMock.createSetup();
    const steps: WorkflowStepsContribution = {
      declares: { createSavedObjectTypes },
      register: () => {},
    };
    const applied = runTaskType.contributions?.apply?.({ 'workflow-steps': [steps] });
    expect(applied?.createSavedObjectTypes?.(nativeEncryption).map(({ name }) => name)).toEqual([
      'native-migrated-type',
    ]);
    expect(createSavedObjectTypes).toHaveBeenCalledTimes(1);
  });
});
