/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowYaml } from '@kbn/workflows';
import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { inferenceMock } from '@kbn/inference-plugin/server/mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { createSearchInferenceEndpointsStart } from '@kbn/search-inference-endpoints/server/create_search_inference_endpoints_start';
import { InferenceFeatureRegistry } from '@kbn/search-inference-endpoints/server/inference_feature_registry';
import { createDiscoveriesRunServices } from './create_discoveries_run_services';

const definition: WorkflowYaml = {
  name: 'Example',
  enabled: true,
  version: '1',
  triggers: [{ type: 'manual' }],
  steps: [{ name: 'end', type: 'console', with: { message: 'Done' } }],
};

const create = () => {
  const core = coreMock.createStart();
  const inference = inferenceMock.createStartContract();
  const logger = loggerMock.create();
  const searchInferenceEndpoints = createSearchInferenceEndpointsStart({
    core: { savedObjects: core.savedObjects, uiSettings: core.uiSettings },
    inference,
    logger,
    featureRegistry: new InferenceFeatureRegistry(logger),
  });
  const getInference = jest.fn(() => inference);
  const management = {
    getWorkflow: jest.fn(),
    getWorkflowExecution: jest.fn(),
    runWorkflow: jest.fn().mockResolvedValue('inline-execution'),
    scheduleWorkflow: jest.fn().mockResolvedValue('queued-execution'),
  };
  const ownedClient = { getWorkflowStatus: jest.fn().mockResolvedValue({ status: 'intact' }) };
  const extensions = {
    hasStepDefinition: jest.fn((id: string) => id === 'registered'),
    initManagedWorkflowsClient: jest.fn().mockResolvedValue(ownedClient),
  };
  const spaces = { getSpaceId: jest.fn(() => 'finance') };
  const services = createDiscoveriesRunServices({
    core,
    authz: securityMock.createStart().authz,
    getActionsClientWithRequest: jest.fn(),
    getInference,
    getSearchInferenceEndpoints: () => searchInferenceEndpoints,
    workflowsManagementApi: management,
    workflowsExtensions: extensions,
    spaces,
  });
  return {
    ...services,
    core,
    inference,
    getInference,
    searchInferenceEndpoints,
    management,
    extensions,
    spaces,
    ownedClient,
  };
};

describe('createDiscoveriesRunServices', () => {
  it('composes the actual services and resolves inference lazily', async () => {
    const fixture = create();
    expect(fixture.getInference).not.toHaveBeenCalled();
    const { coreStart, pluginsStart } = await fixture.getStartServices();
    expect(coreStart).toBe(fixture.core);
    expect(pluginsStart.inference).toBe(fixture.inference);
    expect(pluginsStart.searchInferenceEndpoints).toBe(fixture.searchInferenceEndpoints);
    expect(pluginsStart.spaces?.spacesService).toBe(fixture.spaces);
    expect(pluginsStart.workflowsExtensions).toBe(fixture.extensions);
  });

  it('uses the native owner-bound managed workflow client', async () => {
    const fixture = create();
    const { pluginsStart } = await fixture.getStartServices();
    const client = await pluginsStart.workflowsExtensions.initManagedWorkflowsClient('discoveries');
    expect(client).toBe(fixture.ownedClient);
    expect(fixture.extensions.initManagedWorkflowsClient).toHaveBeenCalledWith('discoveries');
  });

  it('preserves inline execution instead of changing it to a scheduled task', async () => {
    const { workflowsManagementApi, management } = create();
    const request = httpServerMock.createFakeKibanaRequest({});
    const workflow = { id: 'inline', name: 'Inline', enabled: true, definition, yaml: '' };
    await expect(
      workflowsManagementApi.runWorkflow(workflow, 'finance', {}, request)
    ).resolves.toBe('inline-execution');
    expect(management.runWorkflow).toHaveBeenCalledWith(workflow, 'finance', {}, request);
    expect(management.scheduleWorkflow).not.toHaveBeenCalled();
  });

  it('propagates the native workflow authorization failure', async () => {
    const { workflowsManagementApi, management } = create();
    management.runWorkflow.mockRejectedValue(new Error('forbidden'));
    await expect(
      workflowsManagementApi.runWorkflow(
        { id: 'denied', name: 'Denied', enabled: true, definition, yaml: '' },
        'finance',
        {},
        httpServerMock.createFakeKibanaRequest({})
      )
    ).rejects.toThrow('forbidden');
    expect(management.scheduleWorkflow).not.toHaveBeenCalled();
  });

  it('keeps explicit scheduling and its metadata on the native management contract', async () => {
    const { workflowsManagementApi, management } = create();
    const request = httpServerMock.createFakeKibanaRequest({});
    const workflow = {
      id: 'queued',
      name: 'Queued',
      enabled: true,
      definition,
      yaml: '',
      isEphemeral: true,
    };
    const metadata = { attackDiscovery: { executionUuid: 'correlation', source: 'workflow' } };
    await expect(
      workflowsManagementApi.scheduleWorkflow(
        workflow,
        'finance',
        {},
        request,
        'workflow',
        metadata
      )
    ).resolves.toBe('queued-execution');
    expect(management.scheduleWorkflow).toHaveBeenCalledWith(
      workflow,
      'finance',
      {},
      request,
      'workflow',
      metadata
    );
    expect(management.runWorkflow).not.toHaveBeenCalled();
  });
});
