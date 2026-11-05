/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { WorkflowExecutionEngineModel } from '@kbn/workflows';
import { createWorkflowScheduler } from './create_workflow_scheduler';
import type { WorkflowSchedulerTaskManager } from './create_workflow_scheduler';
import {
  createMockStepDataClient,
  createMockWorkflowDataClient,
} from './repositories/data_access_layer/mocks';

jest.mock('./lib/get_user', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue('rule-user'),
}));

const mockCreateWorkflowExecution = jest.fn();
jest.mock('./repositories/workflow_execution_repository', () => ({
  WorkflowExecutionRepository: jest.fn().mockImplementation(() => ({
    createWorkflowExecution: mockCreateWorkflowExecution,
    bulkUpdateWorkflowExecutions: jest.fn(),
  })),
}));

jest.mock('@kbn/workflows', () => ({
  ...jest.requireActual('@kbn/workflows'),
  WorkflowRepository: jest.fn().mockImplementation(() => ({
    getWorkflow: jest.fn().mockResolvedValue(undefined),
    isWorkflowEnabled: jest.fn().mockResolvedValue(true),
  })),
}));

const workflow: WorkflowExecutionEngineModel = {
  id: 'wf-1',
  name: 'Workflow',
  enabled: true,
  spaceId: 'default',
  definition: {
    name: 'Workflow',
    enabled: true,
    version: '1',
    triggers: [{ type: 'manual' }],
    steps: [],
  },
  yaml: 'name: Workflow',
  isTestRun: false,
};

describe('createWorkflowScheduler', () => {
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const logger = loggingSystemMock.createLogger();
  const taskManager = {
    schedule: jest.fn().mockResolvedValue({}),
    bulkSchedule: jest.fn(),
    get: jest.fn(),
    fetch: jest.fn(),
    removeIfExists: jest.fn(),
    runSoon: jest.fn(),
    bulkGet: jest.fn(),
    bulkRemove: jest.fn(),
    ensureScheduled: jest.fn(),
  } as unknown as jest.Mocked<WorkflowSchedulerTaskManager>;
  const request = httpServerMock.createKibanaRequest();

  const createScheduler = () =>
    createWorkflowScheduler({
      taskManager,
      esClient,
      security: { authc: {}, audit: {}, serviceAccounts: { isEnabled: () => false } } as never,
      userProfile: { getCurrentProfileId: jest.fn().mockResolvedValue(null) },
      elasticsearch: elasticsearchServiceMock.createClusterClient(),
      licensing: {
        getLicense: jest
          .fn()
          .mockResolvedValue({ isAvailable: true, isActive: true, hasAtLeast: () => true }),
      } as never,
      logger,
      config: { eventDriven: { enabled: true, logEvents: true, maxChainDepth: 10 } },
      workflowExecutionsDataClient: createMockWorkflowDataClient(),
      stepExecutionsDataClient: createMockStepDataClient(),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateWorkflowExecution.mockResolvedValue(undefined);
  });

  it('persists the execution and schedules a workflow:run task that clones the API key of the request', async () => {
    const { scheduleWorkflow } = createScheduler();

    const { workflowExecutionId } = await scheduleWorkflow(
      workflow,
      { spaceId: 'default', inputs: {}, triggeredBy: 'attack-discovery-pipeline' },
      request
    );

    expect(mockCreateWorkflowExecution).toHaveBeenCalledTimes(1);
    expect(taskManager.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `workflow:${workflowExecutionId}:attack-discovery-pipeline`,
        taskType: 'workflow:run',
        params: { workflowRunId: workflowExecutionId, spaceId: 'default' },
        enabled: true,
      }),
      { request, cloneApiKey: true }
    );
  });

  it('never installs an index, a template or a data stream', async () => {
    const { scheduleWorkflow } = createScheduler();

    await scheduleWorkflow(
      workflow,
      { spaceId: 'default', inputs: {}, triggeredBy: 'alert' },
      request
    );

    expect(esClient.indices.create).not.toHaveBeenCalled();
    expect(esClient.indices.putIndexTemplate).not.toHaveBeenCalled();
    expect(esClient.indices.putMapping).not.toHaveBeenCalled();
    expect(esClient.indices.rollover).not.toHaveBeenCalled();
  });
});
