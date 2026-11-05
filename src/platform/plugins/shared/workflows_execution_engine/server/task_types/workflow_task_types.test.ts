/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { TaskTypeGroup } from '@kbn/task-manager-plugin/server/task';
import { WORKFLOWS_CORE_SELF_CLIENT_ENABLED_FLAG } from '@kbn/workflows';
import { taskType as resumeTaskType } from './workflow_resume.task';
import { taskType as runTaskType } from './workflow_run.task';
import { taskType as scheduledTaskType } from './workflow_scheduled.task';

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
      expect(module.contributions?.keys).toEqual(['alerting-rule-run', 'workflow-steps']);
      expect(module.taskPlugins?.map(({ manifest }) => manifest.id)).toEqual([
        'security',
        'workflowsExecutionEngine',
      ]);
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
    const context = { taskInstance: {} } as never;
    const runner = runTaskType.createTaskRunner(context, {
      plugins: { workflowsExecutionEngine: { runtime: { runWorkflowTask } } },
    } as never);

    await expect(runner.run()).resolves.toEqual({ state: {} });
    await runner.cancel?.();
    expect(runWorkflowTask).toHaveBeenCalledWith(context);
    expect(cancel).toHaveBeenCalled();
  });
});
