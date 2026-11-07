/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { brandSpaceId } from '@kbn/core-spaces-common';
import { loggerMock } from '@kbn/logging-mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { eventLoggerMock } from '@kbn/event-log-plugin/server/mocks';
import { ExecutionStatus } from '@kbn/workflows';
import type { WorkflowExecutionDto } from '@kbn/workflows';
import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import {
  createDurableGenerationRunner,
  getBackgroundGenerationMetadata,
} from './background_generation';
import type { GenerationRunner } from './generation_runner';

const UUID = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
const result = {
  execution_uuid: UUID,
  status: 'completed' as const,
  discovery_count: 0,
  attack_discoveries: [],
};
const request = httpServerMock.createFakeKibanaRequest({ spaceId: brandSpaceId('finance') });
const core = coreMock.createStart();
const params: Parameters<GenerationRunner>[0]['params'] = {
  apiConfig: { connector_id: 'connector-1' },
  alertsIndexPattern: '.alerts-security.alerts-finance',
  authz: securityMock.createStart().authz,
  executionUuid: UUID,
  getEventLogIndex: async () => '.kibana-event-log-*',
  getEventLogger: async () => eventLoggerMock.create(),
  getStartServices: async () => ({ coreStart: core, pluginsStart: {} }),
  logger: loggerMock.create(),
  request,
  trigger: 'agent_builder',
  type: 'attack_discovery',
  workflowConfig: {
    alert_retrieval_mode: 'custom_query',
    alert_retrieval_workflow_ids: [],
    alert_retrieval_workflows_enabled: false,
    default_retrieval_enabled: true,
    skill_enabled: true,
    validation_workflow_id: '',
  },
};

const execution: WorkflowExecutionDto = {
  id: 'child-run',
  spaceId: 'finance',
  status: ExecutionStatus.COMPLETED,
  isTestRun: false,
  startedAt: '2026-11-06T00:00:00.000Z',
  finishedAt: '2026-11-06T00:00:01.000Z',
  error: null,
  duration: 1000,
  workflowDefinition: {
    name: 'Generation',
    enabled: true,
    version: '1',
    triggers: [{ type: 'manual' }],
    steps: [{ name: 'end', type: 'console', with: { message: 'done' } }],
  },
  yaml: '',
  stepExecutions: [],
  context: { output: { result } },
};

const create = () => {
  const management: jest.Mocked<WorkflowsManagementApi> = {
    getWorkflow: jest.fn(),
    getWorkflowExecution: jest.fn().mockResolvedValue(execution),
    runWorkflow: jest.fn(),
    scheduleWorkflow: jest.fn().mockResolvedValue('child-run'),
  };
  return { management, run: createDurableGenerationRunner(management) };
};

describe('durable Discovery generation', () => {
  it('answers pending only after the child is queued, preserving identity, space and correlation', async () => {
    const { run, management } = create();
    const queued = Promise.withResolvers<string>();
    management.scheduleWorkflow.mockReturnValueOnce(queued.promise);
    let answered = false;
    const running = run({
      params,
      input: { mode: 'async' },
      mode: 'async',
      spaceId: 'finance',
    }).then((value) => {
      answered = true;
      return value;
    });
    await Promise.resolve();
    expect(answered).toBe(false);
    expect(management.scheduleWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        isEphemeral: true,
        managed: true,
        managedBy: 'discoveries',
        billable: false,
        definition: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              type: 'security.attack-discovery.run',
              with: expect.objectContaining({ mode: 'sync', connector_id: 'connector-1' }),
            }),
          ]),
        }),
      }),
      'finance',
      {},
      request,
      'agent_builder',
      { attackDiscovery: { executionUuid: UUID, source: 'agent_builder' } }
    );
    queued.resolve('child-run');
    await expect(running).resolves.toEqual({ execution_uuid: UUID, status: 'pending' });
    expect(management.getWorkflowExecution).not.toHaveBeenCalled();
  });

  it('returns the persisted result through the authorized workflow reader', async () => {
    const { run, management } = create();
    await expect(run({ params, input: {}, mode: 'sync', spaceId: 'finance' })).resolves.toEqual(
      result
    );
    expect(management.getWorkflowExecution).toHaveBeenCalledWith('child-run', 'finance', {
      includeOutput: true,
      request,
    });
    expect(management.runWorkflow).not.toHaveBeenCalled();
  });

  it('stops waiting at the caller deadline while leaving the independently owned child queued', async () => {
    const { run, management } = create();
    const entered = Promise.withResolvers<void>();
    management.getWorkflowExecution.mockImplementation(async () => {
      entered.resolve();
      return { ...execution, status: ExecutionStatus.RUNNING };
    });
    const controller = new AbortController();
    const running = run({
      params,
      input: {},
      mode: 'sync',
      spaceId: 'finance',
      waitSignal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await expect(running).resolves.toEqual({ execution_uuid: UUID, status: 'pending' });
    expect(management.scheduleWorkflow).toHaveBeenCalledTimes(1);
    expect(management.runWorkflow).not.toHaveBeenCalled();
  });

  it('surfaces a failed child instead of returning an empty successful result', async () => {
    const { run, management } = create();
    management.getWorkflowExecution.mockResolvedValue({
      ...execution,
      status: ExecutionStatus.FAILED,
      error: { type: 'Error', message: 'generation failed' },
    });
    await expect(run({ params, input: {}, mode: 'sync', spaceId: 'finance' })).rejects.toThrow(
      'generation failed'
    );
  });
});

describe('background generation metadata ownership', () => {
  const owned = {
    workflowId: `attack-discovery-${UUID}`,
    managed: true,
    managedBy: 'discoveries',
    isEphemeral: true,
    metadata: { attackDiscovery: { executionUuid: UUID, source: 'agent_builder' } },
  };
  it('recognizes only the owned ephemeral execution with a matching correlation', () => {
    expect(getBackgroundGenerationMetadata(owned)).toEqual(owned.metadata.attackDiscovery);
  });
  it.each([
    { ...owned, managed: false },
    { ...owned, isEphemeral: false },
    { ...owned, managedBy: 'another-plugin' },
    { ...owned, workflowId: 'ordinary-workflow' },
  ])('ignores metadata from an ordinary execution: %j', (ordinaryExecution) => {
    expect(getBackgroundGenerationMetadata(ordinaryExecution)).toBeUndefined();
  });
  it('rejects missing or mismatched correlation in an owned queued execution', () => {
    expect(() => getBackgroundGenerationMetadata({ ...owned, metadata: {} })).toThrow();
    expect(() =>
      getBackgroundGenerationMetadata({
        ...owned,
        metadata: {
          attackDiscovery: {
            executionUuid: 'b1b2c3d4-e5f6-4789-abcd-ef0123456789',
            source: 'agent_builder',
          },
        },
      })
    ).toThrow('correlation does not match');
  });
});
