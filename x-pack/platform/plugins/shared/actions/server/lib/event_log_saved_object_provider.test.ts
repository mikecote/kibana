/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { actionsClientMock } from '../actions_client/actions_client.mock';
import { createActionsEventLogSavedObjectProvider } from './event_log_saved_object_provider';

describe('connector event-log authorization provider', () => {
  it('keeps authorization bound to each requesting client and checks system connectors', async () => {
    const deniedRequest = httpServerMock.createFakeKibanaRequest({});
    const allowedRequest = httpServerMock.createFakeKibanaRequest({});
    const deniedClient = actionsClientMock.create();
    const allowedClient = actionsClientMock.create();
    deniedClient.get.mockRejectedValue(new Error('connector access denied'));
    const getClient = jest.fn(async (request: KibanaRequest) =>
      request === deniedRequest ? deniedClient : allowedClient
    );
    const provider = createActionsEventLogSavedObjectProvider(getClient);
    const deniedLookup = provider(deniedRequest);
    const allowedLookup = provider(allowedRequest);

    await expect(
      deniedLookup([{ id: 'system-connector-.workflows', type: 'action' }])
    ).rejects.toThrow('connector access denied');
    expect(allowedClient.get).not.toHaveBeenCalled();
    await allowedLookup([{ id: 'system-connector-.workflows', type: 'action' }]);
    expect(allowedClient.get).toHaveBeenCalledWith({
      id: 'system-connector-.workflows',
      throwIfSystemAction: false,
    });
    expect(deniedClient.get).toHaveBeenCalledTimes(1);
    expect(getClient).toHaveBeenNthCalledWith(1, deniedRequest);
    expect(getClient).toHaveBeenNthCalledWith(2, allowedRequest);
  });
});
