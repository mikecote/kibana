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
import { createWorkflowsReadApi, scheduleWorkflowWithEngine } from './workflows_read_api';
import { createStorage } from '../storage/workflow_storage';

jest.mock('../storage/workflow_storage', () => ({
  ...jest.requireActual('../storage/workflow_storage'),
  createStorage: jest.fn(),
}));

const mockSearch = jest.fn();

const storedWorkflow = {
  name: 'Workflow',
  enabled: true,
  tags: [],
  triggerTypes: [],
  yaml: 'name: Workflow',
  definition: { name: 'Workflow', enabled: true, version: '1', triggers: [], steps: [] },
  createdBy: 'elastic',
  lastUpdatedBy: 'elastic',
  spaceId: 'default',
  valid: true,
  deleted_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('createWorkflowsReadApi', () => {
  const esClient = elasticsearchServiceMock.createElasticsearchClient();
  const logger = loggingSystemMock.createLogger();
  const request = httpServerMock.createKibanaRequest();
  const getByIds = jest.fn();
  const core = {
    security: { authc: { getCurrentUser: jest.fn() }, audit: {} },
    userProfile: { getCurrentProfileId: jest.fn().mockResolvedValue(undefined) },
    elasticsearch: { client: elasticsearchServiceMock.createClusterClient() },
  } as never;

  const createApi = () =>
    createWorkflowsReadApi({
      logger,
      esClient,
      core,
      workflowExecutionsDataClient: { getByIds } as never,
      stepExecutionsDataClient: {} as never,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    (createStorage as jest.Mock).mockReturnValue({ getClient: () => ({ search: mockSearch }) });
    mockSearch.mockResolvedValue({
      timed_out: false,
      hits: { hits: [{ _id: 'wf-1', _source: storedWorkflow }] },
    });
  });

  it('builds a storage that never reconciles the index on read', () => {
    createApi();
    expect(createStorage).toHaveBeenCalledWith({ logger, esClient, readOnly: true });
  });

  it('reads a workflow the request may read, with its permissions', async () => {
    const workflow = await createApi().getWorkflow('wf-1', 'default', request);

    expect(workflow).toEqual(
      expect.objectContaining({ id: 'wf-1', permissions: expect.anything() })
    );
  });

  it('returns null for a workflow that does not exist', async () => {
    mockSearch.mockResolvedValue({ timed_out: false, hits: { hits: [] } });

    await expect(createApi().getWorkflow('missing', 'default', request)).resolves.toBeNull();
  });

  it('returns null for an execution of another space', async () => {
    getByIds.mockResolvedValue({ items: [{ document: { id: 'e1', spaceId: 'other' } }] });

    await expect(
      createApi().getWorkflowExecution('e1', 'default', { request, omitStepExecutions: true })
    ).resolves.toBeNull();
  });

  it('reports the status of a managed workflow that is missing', async () => {
    mockSearch.mockResolvedValue({ timed_out: false, hits: { hits: [] } });

    const report = await createApi().getManagedWorkflowStatus(
      'system-attack-discovery-generation' as never,
      { spaceId: 'default' },
      'discoveries'
    );

    expect(report).toEqual(expect.objectContaining({ status: 'missing', installed: false }));
  });
});

describe('scheduleWorkflowWithEngine', () => {
  it('splits the event from the manual inputs and returns the execution id', async () => {
    const scheduleWorkflow = jest.fn().mockResolvedValue({ workflowExecutionId: 'exec-1' });
    const request = httpServerMock.createKibanaRequest();
    const workflow = { id: 'wf-1' } as never;

    const id = await scheduleWorkflowWithEngine({
      scheduleWorkflow,
      workflow,
      spaceId: 'default',
      inputs: { event: { type: 'manual' }, a: 1 },
      request,
      triggeredBy: 'test',
    });

    expect(id).toBe('exec-1');
    expect(scheduleWorkflow).toHaveBeenCalledWith(
      workflow,
      { event: { type: 'manual' }, spaceId: 'default', inputs: { a: 1 }, triggeredBy: 'test' },
      request
    );
  });
});
