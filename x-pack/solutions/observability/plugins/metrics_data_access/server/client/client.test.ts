/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SavedObjectsErrorHelpers } from '@kbn/core/server';
import { savedObjectsClientMock } from '@kbn/core/server/mocks';
import type { SavedObjectsClientContract } from '@kbn/core-saved-objects-api-server';
import { MetricsDataClient, DEFAULT_METRIC_INDICES } from './client';
import { metricsDataSourceSavedObjectName } from '../saved_objects/metrics_data_source';

describe('MetricsDataClient', () => {
  describe('metric indices', () => {
    it('clears overwritten resolver ownership while preserving native default resolution', async () => {
      const client = new MetricsDataClient();
      const savedObjectsClient = savedObjectsClientMock.create();
      savedObjectsClient.get.mockRejectedValue(
        SavedObjectsErrorHelpers.createGenericNotFoundError()
      );
      expect(client.getDefaultMetricIndicesHandlerRegistration()).toEqual({ installed: false });
      client.setDefaultMetricIndicesHandler(async () => 'infra-*', { owner: 'infra' });
      const snapshot = client.getDefaultMetricIndicesHandlerRegistration();
      snapshot.owner = 'changed';
      expect(client.getDefaultMetricIndicesHandlerRegistration()).toEqual({
        installed: true,
        owner: 'infra',
      });
      expect(await client.getMetricIndices({ savedObjectsClient })).toBe('infra-*');
      client.setDefaultMetricIndicesHandler(async () => 'replacement-*');
      expect(client.getDefaultMetricIndicesHandlerRegistration()).toEqual({ installed: true });
      expect(await client.getMetricIndices({ savedObjectsClient })).toBe('replacement-*');
      client.setDefaultMetricIndicesHandler(null, { owner: 'infra' });
      expect(client.getDefaultMetricIndicesHandlerRegistration()).toEqual({ installed: false });
      expect(await client.getMetricIndices({ savedObjectsClient })).toBe(DEFAULT_METRIC_INDICES);
    });

    it('retrieves metrics saved object', async () => {
      const client = new MetricsDataClient();
      const savedObjectsClient = {
        get: jest.fn().mockResolvedValue({ attributes: { metricIndices: 'foo,bar' } }),
      };

      const indices = await client.getMetricIndices({
        savedObjectsClient: savedObjectsClient as unknown as SavedObjectsClientContract,
      });

      expect(savedObjectsClient.get.mock.calls.length).toEqual(1);
      expect(savedObjectsClient.get.mock.calls[0]).toEqual([
        metricsDataSourceSavedObjectName,
        'default',
      ]);
      expect(indices).toEqual('foo,bar');
    });

    it('falls back to provided handler when no metrics saved object exists', async () => {
      const client = new MetricsDataClient();
      client.setDefaultMetricIndicesHandler(async () => {
        return 'fallback-indices*';
      });
      const savedObjectsClient = {
        get: jest.fn().mockRejectedValue(SavedObjectsErrorHelpers.createGenericNotFoundError()),
      };

      const indices = await client.getMetricIndices({
        savedObjectsClient: savedObjectsClient as unknown as SavedObjectsClientContract,
      });

      expect(savedObjectsClient.get.mock.calls.length).toEqual(1);
      expect(savedObjectsClient.get.mock.calls[0]).toEqual([
        metricsDataSourceSavedObjectName,
        'default',
      ]);
      expect(indices).toEqual('fallback-indices*');
    });

    it('falls back to static indices when no fallback exists', async () => {
      const client = new MetricsDataClient();
      const savedObjectsClient = {
        get: jest.fn().mockRejectedValue(SavedObjectsErrorHelpers.createGenericNotFoundError()),
      };

      const indices = await client.getMetricIndices({
        savedObjectsClient: savedObjectsClient as unknown as SavedObjectsClientContract,
      });
      expect(indices).toEqual(DEFAULT_METRIC_INDICES);
    });
  });
});
