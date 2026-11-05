/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import type { ILicense } from '@kbn/licensing-types';

import {
  createOsqueryActionService,
  getOsqueryRunSavedObjectTypes,
} from './create_osquery_action_service';

const license = (platinum: boolean) =>
  ({
    isActive: platinum,
    hasAtLeast: () => platinum,
  } as unknown as ILicense);

describe('createOsqueryActionService', () => {
  const build = (platinum = true) => {
    const elasticsearch = elasticsearchServiceMock.createStart();
    const savedObjects = savedObjectsServiceMock.createStartContract();
    const loggerFactory = loggingSystemMock.create();
    const analytics = { reportEvent: jest.fn() };
    const fleetActionsClient = { bulkCreate: jest.fn() };
    const fleetRunServices = {
      agentService: {},
      packageService: {},
      agentPolicyService: {},
      packagePolicyService: {},
      createFleetActionsClient: jest.fn().mockReturnValue(fleetActionsClient),
    } as never;

    return {
      elasticsearch,
      savedObjects,
      loggerFactory,
      analytics,
      fleetActionsClient,
      fleetRunServices,
      promise: createOsqueryActionService({
        fleetRunServices,
        elasticsearch: elasticsearch.client,
        savedObjects,
        license$: of(license(platinum)),
        loggerFactory,
        analytics,
      }),
    };
  };

  it('returns the service the plugin exposes to rules', async () => {
    const { promise } = build();
    const service = await promise;

    expect(service.create).toEqual(expect.any(Function));
    expect(service.containsDynamicQueries).toEqual(expect.any(Function));
    expect(service.stop).toEqual(expect.any(Function));
    expect(service.logger).toBeDefined();
    service.stop();
  });

  it('creates the Fleet actions client for osquery', async () => {
    const { promise, fleetRunServices } = build();
    await promise;

    expect(
      (fleetRunServices as { createFleetActionsClient: jest.Mock }).createFleetActionsClient
    ).toHaveBeenCalledWith('osquery');
  });

  it('lists the saved object types a live query of a rule reads', () => {
    expect(getOsqueryRunSavedObjectTypes().map(({ name }) => name)).toEqual([
      'osquery-saved-query',
      'osquery-pack',
      'osquery-pack-asset',
    ]);
  });
});
