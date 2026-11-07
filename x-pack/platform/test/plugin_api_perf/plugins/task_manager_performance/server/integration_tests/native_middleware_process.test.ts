/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'node:path';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { performance } from 'node:perf_hooks';
import { SAMPLE_TASK_MIDDLEWARE_ID } from '@kbn/sample-task-plugin/server/task_scheduling_middleware';
import { savedObjectToConcreteTaskInstance } from '@kbn/task-manager-plugin/server/lib/task_instance_serialization';
import type { SerializedConcreteTaskInstance } from '@kbn/task-manager-plugin/server/task';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { z } from '@kbn/zod/v4';
import {
  createTaskManagerPerformanceMiddleware,
  TASK_MANAGER_PERFORMANCE_MIDDLEWARE_ID,
} from '../task_scheduling_middleware';
import { taskType } from './task_scheduling_middleware.task';

const stateSchema = z.object({
  apiKeyId: z.string().min(1),
  params: z.object({
    originalParams: z.object({
      workflowRunId: z.string(),
      spaceId: z.literal('default'),
      trackExecutionTimeline: z.literal(true),
    }),
    superFly: z.literal('My middleware param!'),
  }),
  taskState: z.object({ perf: z.object({ id: z.string(), scheduledAt: z.number() }) }),
});

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native scheduling middleware in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    const logging = loggingSystemMock.create();
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger: logging.get(),
        workflows: {},
        executionTask: {
          taskType,
          file: join(__dirname, 'task_scheduling_middleware.task.ts'),
          name: 'test__native_middleware',
        },
        middlewareIds: [SAMPLE_TASK_MIDDLEWARE_ID, TASK_MANAGER_PERFORMANCE_MIDDLEWARE_ID],
      });
    });
    afterAll(async () => harness?.stop());

    it('uses the registered native chain before encrypted storage and measures scheduling across processes', async () => {
      const failure = jest.fn();
      for (const suffix of ['first', 'second']) {
        const taskId = `middleware-${suffix}`;
        const result = await harness
          .runTask(taskType.type, { id: `dispatch-${suffix}`, params: { taskId } }, failure)
          .catch((error: Error) => {
            throw new Error(
              `${error.message}\n${JSON.stringify(loggingSystemMock.collect(logging))}`,
              { cause: error }
            );
          });
        const state = stateSchema.parse(result?.state);
        expect(state.params.originalParams.workflowRunId).toBe(taskId);
        const { _source: source } = await harness.es.get<{ task: SerializedConcreteTaskInstance }>({
          index: '.kibana_task_manager',
          id: `task:${taskId}`,
        });
        if (!source) throw new Error('Native scheduled task was not persisted');
        expect(source.task.apiKey).toEqual(expect.any(String));
        expect(Buffer.from(source.task.apiKey ?? '', 'base64').toString()).not.toContain(
          state.apiKeyId
        );
        const taskInstance = savedObjectToConcreteTaskInstance({
          id: taskId,
          type: 'task',
          attributes: source.task,
        });
        const mark = `perfTask_markAsRunning_${state.taskState.perf.id}_1`;
        expect(
          performance.getEntriesByName(`perfTask_schedule_${state.taskState.perf.id}`)
        ).toEqual([]);
        const previousMeasures = performance.getEntriesByName('perfTask.firstMarkAsRunning').length;
        try {
          await createTaskManagerPerformanceMiddleware().beforeMarkRunning({
            taskInstance,
            executionUuid: `mark-${suffix}`,
          });
          const measures = performance.getEntriesByName('perfTask.firstMarkAsRunning');
          expect(measures).toHaveLength(previousMeasures + 1);
          const elapsed = Date.now() - state.taskState.perf.scheduledAt;
          const duration = measures[measures.length - 1].duration;
          expect(duration).toBeGreaterThanOrEqual(0);
          expect(Math.abs(duration - elapsed)).toBeLessThan(1000);
        } finally {
          performance.clearMarks(mark);
          performance.clearMeasures('perfTask.firstMarkAsRunning');
        }
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 2);
      expect(failure).not.toHaveBeenCalled();
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
