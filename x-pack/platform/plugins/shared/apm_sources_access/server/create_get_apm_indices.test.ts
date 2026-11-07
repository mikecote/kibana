/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { savedObjectsClientMock } from '@kbn/core-saved-objects-api-server-mocks';
import { SavedObjectsErrorHelpers } from '@kbn/core/server';
import { configSchema } from '../common/config_schema';
import { createGetApmIndices } from './create_get_apm_indices';

describe('shared native APM index resolution', () => {
  it('uses the current configured indices and preserves saved-object overrides', async () => {
    const client = savedObjectsClientMock.create();
    client.get.mockResolvedValue({
      id: 'apm-indices',
      type: 'apm-indices',
      references: [],
      attributes: { apmIndices: { transaction: 'custom-transactions-*' }, isSpaceAware: true },
    });
    let configured = configSchema.validate({}).indices;
    const getApmIndices = createGetApmIndices(() => configured);
    const indices = getApmIndices(client);
    configured = { ...configured, metric: 'current-metrics-*' };
    expect(await indices).toEqual({ ...configured, transaction: 'custom-transactions-*' });
    expect(client.get).toHaveBeenCalledWith('apm-indices', 'apm-indices');
  });

  it('uses configured defaults only for a missing saved object and propagates storage failures', async () => {
    const client = savedObjectsClientMock.create();
    const configured = configSchema.validate({}).indices;
    const getApmIndices = createGetApmIndices(() => configured);
    client.get.mockRejectedValueOnce(SavedObjectsErrorHelpers.createGenericNotFoundError());
    expect(await getApmIndices(client)).toEqual(configured);
    const failure = new Error('storage unavailable');
    client.get.mockRejectedValueOnce(failure);
    await expect(getApmIndices(client)).rejects.toBe(failure);
  });
});
