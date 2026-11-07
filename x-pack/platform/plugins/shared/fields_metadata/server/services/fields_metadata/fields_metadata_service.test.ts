/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { FieldsMetadataService } from './fields_metadata_service';

const field = { name: 'custom.logs.request_id', type: 'keyword', description: 'Request identity' };

describe('field metadata execution services', () => {
  it('snapshots the active provider of each extractor without retaining a mutable registry', () => {
    const service = new FieldsMetadataService(loggerMock.create());
    const registry = service.setup();
    registry.registerIntegrationFieldsExtractor(async () => ({}), 'fleet');
    registry.registerIntegrationListExtractor(async () => [], 'fleet');
    const first = service.getTaskProcessSettings();
    registry.registerIntegrationFieldsExtractor(async () => ({}), 'replacement');
    registry.registerStreamsFieldsExtractor(async () => ({}), 'streams');
    expect(first).toEqual({
      integrationFieldsExtractor: 'fleet',
      integrationListExtractor: 'fleet',
    });
    expect(service.getTaskProcessSettings()).toEqual({
      integrationFieldsExtractor: 'replacement',
      integrationListExtractor: 'fleet',
      streamsFieldsExtractor: 'streams',
    });
  });

  it('resolves authorization and scoped source reads for each request before extracting metadata', async () => {
    const service = new FieldsMetadataService(loggerMock.create());
    const registry = service.setup();
    const integrationFieldsExtractor = jest
      .fn()
      .mockResolvedValue({ 'custom.logs': { [field.name]: field } });
    const integrationListExtractor = jest
      .fn()
      .mockResolvedValue([{ id: 'custom', name: 'custom', version: '1.0.0' }]);
    registry.registerIntegrationFieldsExtractor(integrationFieldsExtractor, 'fleet');
    registry.registerIntegrationListExtractor(integrationListExtractor, 'fleet');
    const core = coreMock.createStart();
    const getCapabilities = jest
      .fn()
      .mockResolvedValue({ fleet: { read: true }, fleetv2: { read: true } });
    const runtime = service.startFromServices({
      elasticsearch: core.elasticsearch,
      getCapabilities,
    });
    const allowed = httpServerMock.createKibanaRequest();
    const allowedClient = await runtime.getClient(allowed);
    expect(
      (await allowedClient.getByName(field.name, { source: 'integration' }))?.toPlain()
    ).toEqual(expect.objectContaining({ name: field.name }));
    getCapabilities.mockResolvedValueOnce({ fleet: { read: false }, fleetv2: { read: true } });
    const denied = httpServerMock.createKibanaRequest();
    const deniedClient = await runtime.getClient(denied);
    await expect(
      deniedClient.getByName(field.name, { source: 'integration' })
    ).resolves.toBeUndefined();
    expect(getCapabilities.mock.calls).toEqual([[allowed], [denied]]);
    expect(core.elasticsearch.client.asScoped).toHaveBeenCalledWith(allowed);
    expect(core.elasticsearch.client.asScoped).toHaveBeenCalledWith(denied);
    expect(integrationFieldsExtractor).toHaveBeenCalledTimes(1);
  });

  it('keeps native default capabilities resolution and handles Fleet being absent', async () => {
    const service = new FieldsMetadataService(loggerMock.create());
    const core = coreMock.createStart();
    core.capabilities.resolveCapabilities.mockResolvedValue({
      navLinks: {},
      management: {},
      catalogue: {},
    });
    const request = httpServerMock.createKibanaRequest();
    const client = await service.start(core).getClient(request);
    await expect(client.getByName(field.name, { source: 'integration' })).resolves.toBeUndefined();
    expect(core.capabilities.resolveCapabilities).toHaveBeenCalledWith(request, {
      capabilityPath: '*',
    });
  });
});
