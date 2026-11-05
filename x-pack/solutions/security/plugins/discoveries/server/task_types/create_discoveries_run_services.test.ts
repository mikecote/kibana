/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core-http-server-mocks';
import { createDiscoveriesRunServices } from './create_discoveries_run_services';

const create = () => {
  const readApi = {
    assertWorkflowAccess: jest.fn().mockResolvedValue(undefined),
    getManagedWorkflowStatus: jest.fn().mockResolvedValue({ status: 'intact' }),
    getWorkflow: jest.fn(),
    getWorkflowExecution: jest.fn(),
  };
  const scheduleWorkflow = jest.fn().mockResolvedValue({ workflowExecutionId: 'execution-1' });
  const inference = { getConnectorById: jest.fn() };
  const getInference = jest.fn().mockReturnValue(inference);
  const core = { featureFlags: {} } as never;
  const services = createDiscoveriesRunServices({
    core,
    authz: { actions: {} } as never,
    getActionsClientWithRequest: jest.fn(),
    getInference: getInference as never,
    readApi,
    scheduleWorkflow,
    hasStepDefinition: (id) => id === 'registered',
  });
  return { ...services, readApi, scheduleWorkflow, inference, getInference, core };
};

describe('createDiscoveriesRunServices', () => {
  it('gives the steps Core, the plugins and the space of the request, building inference when first read', async () => {
    const { getStartServices, getInference, inference, core } = create();
    expect(getInference).not.toHaveBeenCalled();

    const { coreStart, pluginsStart } = await getStartServices();

    expect(coreStart).toBe(core);
    expect(pluginsStart.inference).toBe(inference);
    expect(pluginsStart.searchInferenceEndpoints).toBeUndefined();
    const request = httpServerMock.createKibanaRequest();
    expect(pluginsStart.spaces?.spacesService.getSpaceId(request)).toBe('default');
    expect(pluginsStart.spaces?.spacesService.getSpaceId({ spaceId: 'security' } as never)).toBe(
      'security'
    );
    expect(pluginsStart.workflowsExtensions.hasStepDefinition('registered')).toBe(true);
    expect(pluginsStart.workflowsExtensions.hasStepDefinition('other')).toBe(false);
  });

  it('answers the managed workflow status with the plugin that owns them', async () => {
    const { getStartServices, readApi } = create();
    const { pluginsStart } = await getStartServices();

    const client = await pluginsStart.workflowsExtensions.initManagedWorkflowsClient('discoveries');
    await client.getWorkflowStatus('id' as never, { spaceId: 'default' } as never);

    expect(readApi.getManagedWorkflowStatus).toHaveBeenCalledWith(
      'id',
      { spaceId: 'default' },
      'discoveries'
    );
  });

  it('schedules the workflows a step starts, running one only when the request may execute it', async () => {
    const { workflowsManagementApi, readApi, scheduleWorkflow } = create();
    const request = httpServerMock.createKibanaRequest();
    const workflow = { id: 'workflow-1', isEphemeral: false } as never;

    const executionId = await workflowsManagementApi.runWorkflow(
      workflow,
      'default',
      { event: { a: 1 }, size: 2 },
      request
    );

    expect(executionId).toBe('execution-1');
    expect(readApi.assertWorkflowAccess).toHaveBeenCalledWith(
      'workflow-1',
      'default',
      'execute',
      request
    );
    expect(scheduleWorkflow).toHaveBeenCalledWith(
      workflow,
      { event: { a: 1 }, spaceId: 'default', inputs: { size: 2 }, triggeredBy: 'manual' },
      request
    );
  });

  it('does not run a workflow the request may not execute', async () => {
    const { workflowsManagementApi, readApi, scheduleWorkflow } = create();
    readApi.assertWorkflowAccess.mockRejectedValue(new Error('forbidden'));

    await expect(
      workflowsManagementApi.runWorkflow(
        { id: 'workflow-1', isEphemeral: false } as never,
        'default',
        {},
        httpServerMock.createKibanaRequest()
      )
    ).rejects.toThrow('forbidden');
    expect(scheduleWorkflow).not.toHaveBeenCalled();
  });

  it('skips the access check for an ephemeral workflow, as Kibana does', async () => {
    const { workflowsManagementApi, readApi, scheduleWorkflow } = create();

    await workflowsManagementApi.runWorkflow(
      { id: 'workflow-1', isEphemeral: true } as never,
      'default',
      {},
      httpServerMock.createKibanaRequest(),
      'attack-discovery'
    );

    expect(readApi.assertWorkflowAccess).not.toHaveBeenCalled();
    expect(scheduleWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ triggeredBy: 'attack-discovery' }),
      expect.anything()
    );
  });
});
