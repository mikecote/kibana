/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';
import {
  WORKFLOWS_EXECUTIONS_DATA_STREAM,
  WORKFLOWS_STEP_EXECUTIONS_DATA_STREAM,
} from '../repositories/data_access_layer/implementations/data_stream/constants';
import { createDataStreamDataClients } from '../repositories/data_access_layer/implementations/data_stream/data_stream_data_client_bundle';
import { WorkflowExecutionRepository } from '../repositories/workflow_execution_repository';
import {
  getWorkflowGlobalTimeoutResumeTaskId,
  getWorkflowImmediateResumeTaskId,
} from '../workflow_task_manager/workflow_task_manager';

interface ScheduledTaskDocument {
  task: {
    taskType: string;
    params: string;
    apiKey?: string;
    userScope?: { apiKeyId: string };
    runAt: string;
  };
}

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native data-stream scheduling and rollover in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        includeResumeTask: true,
        settings: { workflowsExecutionEngine: { storage: { source: 'data_stream' } } },
        workflows: Object.fromEntries(
          ['wait-first', 'wait-second'].map((id) => [
            id,
            {
              steps: [
                { name: 'pause', type: 'wait', with: { duration: '7s' } },
                { name: 'finished', type: 'console', with: { message: 'resumed' } },
              ],
            },
          ])
        ),
      });
    });
    afterAll(async () => harness?.stop());

    it('preserves Main CAS and worker updates across two rollovers and native resume tasks', async () => {
      const failure = jest.fn();
      const spawnedBefore = harness.getWorkerStats().spawned;
      await harness.run('wait-first', failure);
      await harness.run('wait-second', failure);
      expect(harness.getWorkerStats().spawned - spawnedBefore).toBe(reuse ? 1 : 2);
      const executions: Array<{ id: string }> = [];
      for (const id of ['wait-first', 'wait-second']) {
        const [execution] = await harness.executionsOf(id);
        expect(execution.status).toBe('waiting');
        if (typeof execution.id !== 'string')
          throw new Error('Persisted workflow execution has no id');
        executions.push({ id: execution.id });
      }
      await harness.es.indices.refresh({ index: '.kibana_task_manager' });
      const { hits } = await harness.es.search<ScheduledTaskDocument>({
        index: '.kibana_task_manager',
        query: { term: { 'task.taskType': 'workflow:resume' } },
        size: 100,
      });
      expect(hits.hits.length).toBeGreaterThanOrEqual(2);
      expect(harness.createdTaskCounts.reduce((total, count) => total + count, 0)).toBe(
        hits.hits.length
      );
      for (const hit of hits.hits) {
        expect(hit._source?.task.apiKey).toEqual(expect.any(String));
        expect(hit._source?.task.apiKey).not.toBe(harness.apiKey);
        const { apiKey, userScope } = hit._source?.task ?? {};
        if (!apiKey || !userScope?.apiKeyId)
          throw new Error('Native task credential metadata was not persisted');
        expect(Buffer.from(apiKey, 'base64').toString()).not.toContain(userScope.apiKeyId);
        expect(JSON.parse(hit._source?.task.params ?? '')).toEqual({
          workflowRunId: expect.any(String),
          spaceId: 'default',
        });
      }
      const clients = createDataStreamDataClients({
        esClient: harness.es,
        logger: loggingSystemMock.createLogger(),
      });
      await clients.init();
      const mainRepository = new WorkflowExecutionRepository(clients.createWorkflowDataClient());
      const revisions = await Promise.all(
        executions.map(({ id }) => mainRepository.getWorkflowExecutionWithVersion(id, 'default'))
      );
      try {
        for (const { id } of executions) {
          await mainRepository.updateWorkflowExecution(
            { id, metadata: { fromMainBeforeResume: true } },
            { refresh: 'wait_for' }
          );
        }
        for (let rollover = 0; rollover < 2; rollover++) {
          for (const index of [
            WORKFLOWS_EXECUTIONS_DATA_STREAM,
            WORKFLOWS_STEP_EXECUTIONS_DATA_STREAM,
          ]) {
            await harness.es.indices.rollover({ alias: index });
          }
        }
        await sleep(7500);
        for (const execution of executions) {
          const task = hits.hits.find(
            (hit) =>
              hit._source &&
              JSON.parse(hit._source.task.params).workflowRunId === execution.id &&
              hit._id !== `task:${getWorkflowGlobalTimeoutResumeTaskId(execution.id)}`
          );
          if (!task?._source || !task._id) throw new Error('Native resume task was not persisted');
          await harness.runTask(
            'workflow:resume',
            {
              id: task._id.replace(/^task:/, ''),
              params: JSON.parse(task._source.task.params),
            },
            failure
          );
          const immediateId = getWorkflowImmediateResumeTaskId(execution.id);
          const immediate = await harness.es.get<ScheduledTaskDocument>({
            index: '.kibana_task_manager',
            id: `task:${immediateId}`,
          });
          if (!immediate._source)
            throw new Error('Native timer did not schedule the immediate resume');
          await harness.runTask(
            'workflow:resume',
            {
              id: immediateId,
              params: JSON.parse(immediate._source.task.params),
            },
            failure
          );
          const staleRevision = revisions[executions.indexOf(execution)];
          if (!staleRevision) throw new Error('Main did not read the waiting execution revision');
          expect(
            await mainRepository.tryUpdateWorkflowExecutionWithVersion(
              { id: execution.id, metadata: { stale: true } },
              staleRevision
            )
          ).toBe(false);
          await mainRepository.updateWorkflowExecution(
            { id: execution.id, executedBy: 'main-reviewer' },
            { refresh: 'wait_for' }
          );
          const resumed = await mainRepository.getWorkflowExecutionWithVersion(
            execution.id,
            'default'
          );
          expect(resumed?.execution).toMatchObject({
            status: 'completed',
            metadata: { fromMainBeforeResume: true },
          });
          if (!resumed) throw new Error('Main could not read the resumed execution');
          expect(
            await mainRepository.tryUpdateWorkflowExecutionWithVersion(
              { id: execution.id, metadata: { reviewed: true } },
              resumed
            )
          ).toBe(true);
          expect(
            await mainRepository.getWorkflowExecutionById(execution.id, 'default')
          ).toMatchObject({
            status: 'completed',
            metadata: { reviewed: true },
            executedBy: 'main-reviewer',
          });
          expect(
            await mainRepository.getWorkflowExecutionById(execution.id, 'another-space')
          ).toBeNull();
          expect(
            (await harness.stepsOf(execution.id)).map(({ stepId, status }) => ({ stepId, status }))
          ).toEqual(
            expect.arrayContaining([
              { stepId: 'pause', status: 'completed' },
              { stepId: 'finished', status: 'completed' },
            ])
          );
        }
      } finally {
        clients.stop();
      }
      expect(harness.getWorkerStats().spawned - spawnedBefore).toBe(reuse ? 2 : 6);
      expect(failure).not.toHaveBeenCalled();
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
