/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { asSpaceId } from '@kbn/core-spaces-common';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import type { FieldsMetadataTaskProcessSettings } from '@kbn/fields-metadata-plugin/server';
import { loggerMock } from '@kbn/logging-mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { ConfigSchema } from '@kbn/spaces-plugin/server/config';
import { spacesMock } from '@kbn/spaces-plugin/server/mocks';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createFieldsMetadataRunServices } from './fields_metadata_runtime_contribution';
import { WorkflowRuntimeServices } from './workflow_runtime_services';

const features: KibanaFeatureConfig[] = ['fleet', 'fleetv2'].map((id) => ({
  id,
  name: id,
  category: { id: 'management', label: 'Management' },
  app: [id],
  privileges: {
    all: { app: [id], savedObject: { all: [], read: [] }, ui: ['read'] },
    read: { app: [id], savedObject: { all: [], read: [] }, ui: ['read'] },
  },
}));
const create = (metadata: FieldsMetadataTaskProcessSettings = {}) => {
  const core = coreMock.createStart();
  const security = securityMock.createStart();
  security.authz.mode.useRbacForRequest.mockReturnValue(false);
  const spaces = spacesMock.createStart();
  spaces.spacesService.getActiveSpace.mockResolvedValue({
    id: asSpaceId('default'),
    name: 'Default',
    disabledFeatures: [],
  });
  const host: TaskHost = {
    logger: loggerMock.create(),
    elasticsearch: core.elasticsearch.client,
    savedObjects: core.savedObjects,
    security: { ...core.security, fips: coreMock.createSetup().security.fips },
    executionContext: core.executionContext,
    http: core.http,
    analytics: core.analytics,
    server: { uuid: 'server', version: '9.9.9', buildNum: 1, isServerless: false },
    plugins: { security },
    settings: {
      fieldsMetadataRuntime: metadata,
      spacesRuntime: {
        config: ConfigSchema.validate({}, { offering: 'traditional' }),
        buildFlavor: 'traditional',
        features,
        cpsEnabled: false,
      },
    },
  };
  const runtime = new WorkflowRuntimeServices(
    [],
    () => ({
      host,
      logger: host.logger,
      settings: {},
      isServerless: false,
      kibanaVersion: '9.9.9',
    }),
    { spaces }
  );
  const service = () => createFieldsMetadataRunServices(host, runtime.getService);
  return { host, core, spaces, runtime, service };
};

describe('native field metadata run services', () => {
  it('serves native ECS fields when Kibana has registered no external extractors', async () => {
    const fixture = create();
    const client = await fixture.service().getClient(httpServerMock.createKibanaRequest());
    expect((await client.getByName('host.name'))?.toPlain()).toEqual(
      expect.objectContaining({ flat_name: 'host.name', type: 'keyword', source: 'ecs' })
    );
  });

  it('uses each slot’s active provider and awaits the first integration catalog load', async () => {
    const fixture = create({
      integrationFieldsExtractor: 'fields',
      integrationListExtractor: 'catalog',
    });
    const fields = jest.fn().mockResolvedValue({
      'custom.logs': {
        'custom.logs.marker': {
          name: 'custom.logs.marker',
          type: 'keyword',
          description: 'Native integration field',
        },
      },
    });
    const catalog = jest
      .fn()
      .mockResolvedValue([{ id: 'custom', name: 'custom', version: '1.0.0' }]);
    const unused = jest.fn();
    fixture.runtime.registerService('fieldsMetadata.extractors.fields', {
      integrationFieldsExtractor: fields,
      integrationListExtractor: unused,
    });
    fixture.runtime.registerService('fieldsMetadata.extractors.catalog', {
      integrationListExtractor: catalog,
      integrationFieldsExtractor: unused,
    });
    const client = await fixture.service().getClient(httpServerMock.createKibanaRequest());
    expect(catalog).not.toHaveBeenCalled();
    expect(
      (
        await client.getByName('custom.logs.marker', {
          source: 'integration',
          integration: 'custom',
          dataset: 'custom.logs',
        })
      )?.toPlain()
    ).toEqual(
      expect.objectContaining({
        name: 'custom.logs.marker',
        source: 'integration',
        description: 'Native integration field',
      })
    );
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(fields).toHaveBeenCalledWith({ integration: 'custom', dataset: 'custom.logs' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('binds stream extraction to the current request’s real scoped Elasticsearch client', async () => {
    const fixture = create({ streamsFieldsExtractor: 'streams' });
    const streams = jest.fn().mockResolvedValue({ marker: { name: 'marker', type: 'keyword' } });
    fixture.runtime.registerService('fieldsMetadata.extractors.streams', {
      streamsFieldsExtractor: streams,
    });
    const request = httpServerMock.createKibanaRequest();
    const client = await fixture.service().getClient(request);
    expect(
      (await client.getByName('marker', { source: 'streams', streamName: 'logs' }))?.toPlain()
    ).toEqual(expect.objectContaining({ name: 'marker', source: 'streams' }));
    expect(fixture.core.elasticsearch.client.asScoped).toHaveBeenCalledWith(request);
    expect(streams).toHaveBeenCalledWith({
      streamName: 'logs',
      esClient: fixture.core.elasticsearch.client.asScoped(request).asCurrentUser,
    });
  });

  it('denies integration reads when the actual space disables Fleet', async () => {
    const fixture = create({
      integrationFieldsExtractor: 'fleet',
      integrationListExtractor: 'fleet',
    });
    const fields = jest.fn();
    const catalog = jest.fn();
    fixture.runtime.registerService('fieldsMetadata.extractors.fleet', {
      integrationFieldsExtractor: fields,
      integrationListExtractor: catalog,
    });
    fixture.spaces.spacesService.getActiveSpace.mockResolvedValue({
      id: asSpaceId('default'),
      name: 'Default',
      disabledFeatures: ['fleet'],
    });
    const client = await fixture.service().getClient(httpServerMock.createKibanaRequest());
    await expect(
      client.getByName('custom.logs.marker', { source: 'integration', integration: 'custom' })
    ).resolves.toBeUndefined();
    expect(fields).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });

  it('rejects an absent registered provider instead of substituting an empty extractor', () => {
    const fixture = create({ integrationFieldsExtractor: 'missing' });
    expect(fixture.service).toThrow(
      'No workflow runtime service provider registered for fieldsMetadata.extractors.missing'
    );
  });

  it('rejects a provider that does not implement its registered slot', () => {
    const fixture = create({ streamsFieldsExtractor: 'broken' });
    fixture.runtime.registerService('fieldsMetadata.extractors.broken', {});
    expect(fixture.service).toThrow('has no stream field extractor');
  });

  it('requires the native metadata registry snapshot', () => {
    const fixture = create();
    delete fixture.host.settings?.fieldsMetadataRuntime;
    expect(fixture.service).toThrow('requires its native registry');
  });
});
