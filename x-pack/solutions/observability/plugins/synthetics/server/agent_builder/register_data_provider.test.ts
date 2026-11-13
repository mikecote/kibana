/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { savedObjectsClientMock } from '@kbn/core-saved-objects-api-server-mocks';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { MonitorConfigRepository } from '../services/monitor_config_repository';
import { ConfigKey } from '../../common/runtime_types';
import { createSyntheticsMonitorDetailsDataProvider } from './register_data_provider';

describe('native Synthetics monitor data provider', () => {
  it.each(['synthetics-monitor-multi-space', 'synthetics-monitor'])(
    'uses the native repository for %s and returns only public monitor fields',
    async (type) => {
      const client = savedObjectsClientMock.create();
      const encryption = encryptedSavedObjectsMock.createStart().getClient();
      const decrypt = jest.spyOn(encryption, 'getDecryptedAsInternalUser');
      const getRepository = jest.fn(async () => new MonitorConfigRepository(client, encryption));
      const provider = createSyntheticsMonitorDetailsDataProvider(getRepository);
      const request = httpServerMock.createKibanaRequest();
      const fields = {
        [ConfigKey.NAME]: 'Native monitor',
        [ConfigKey.MONITOR_TYPE]: 'http',
        [ConfigKey.ENABLED]: true,
        [ConfigKey.SCHEDULE]: { number: '3', unit: 'm' },
        [ConfigKey.LOCATIONS]: [{ id: 'us-east', label: 'US East' }],
        [ConfigKey.TAGS]: ['production'],
      };
      client.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            id: 'monitor',
            type,
            attributes: { ...fields, secrets: 'encrypted-secret', 'ssl.key': 'private-key' },
            references: [],
          },
        ],
      });
      expect(await provider({ request, configId: 'monitor' })).toEqual({
        id: 'monitor',
        name: 'Native monitor',
        type: 'http',
        enabled: true,
        schedule: { number: '3', unit: 'm' },
        locations: [{ id: 'us-east', label: 'US East' }],
        tags: ['production'],
      });
      expect(getRepository).toHaveBeenCalledWith(request);
      expect(client.bulkGet).toHaveBeenCalledWith([
        { type: 'synthetics-monitor-multi-space', id: 'monitor' },
        { type: 'synthetics-monitor', id: 'monitor' },
      ]);
      expect(decrypt).not.toHaveBeenCalled();
    }
  );

  it('propagates repository authorization failures', async () => {
    const client = savedObjectsClientMock.create();
    client.bulkGet.mockRejectedValue(new Error('Monitor access denied'));
    const provider = createSyntheticsMonitorDetailsDataProvider(
      async () =>
        new MonitorConfigRepository(client, encryptedSavedObjectsMock.createStart().getClient())
    );
    await expect(
      provider({ request: httpServerMock.createKibanaRequest(), configId: 'private-monitor' })
    ).rejects.toThrow('Monitor access denied');
  });
});
