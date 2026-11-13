/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock, savedObjectsClientMock } from '@kbn/core/server/mocks';
import { SavedObjectsErrorHelpers } from '@kbn/core/server';
import { brandSpaceId } from '@kbn/core-spaces-common';
import { createMaintenanceStateReader, createMaintenanceStateStore } from './state_store';
import {
  SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_ID,
  SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_TYPE,
} from './saved_object';

const create = () => {
  const client = savedObjectsClientMock.create();
  const finance = savedObjectsClientMock.create();
  const sales = savedObjectsClientMock.create();
  client.asScopedToNamespace.mockImplementation((space) => (space === 'finance' ? finance : sales));
  const getUnsafeInternalClient = jest.fn().mockReturnValue(client);
  const reader = createMaintenanceStateReader(
    createMaintenanceStateStore(() => ({ getUnsafeInternalClient }))
  );
  finance.get.mockResolvedValue({
    id: SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_ID,
    type: SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_TYPE,
    attributes: { state: 'paused' },
    references: [],
  });
  sales.get.mockRejectedValue(SavedObjectsErrorHelpers.createGenericNotFoundError());
  return { client, finance, sales, getUnsafeInternalClient, reader };
};
const request = (space: string) =>
  httpServerMock.createKibanaRequest({ spaceId: brandSpaceId(space) });

describe('significant events maintenance execution reader', () => {
  it('reads each space independently and treats a missing document as enabled', async () => {
    const fixture = create();
    expect(fixture.getUnsafeInternalClient).not.toHaveBeenCalled();
    await expect(fixture.reader.getState({ request: request('finance') })).resolves.toBe('paused');
    await expect(fixture.reader.getState({ request: request('sales') })).resolves.toBe('enabled');
    expect(fixture.client.asScopedToNamespace.mock.calls).toEqual([['finance'], ['sales']]);
    expect(fixture.getUnsafeInternalClient).toHaveBeenCalledTimes(1);
    expect(fixture.getUnsafeInternalClient).toHaveBeenCalledWith({
      includedHiddenTypes: [SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_TYPE],
    });
  });

  it('rechecks persisted state when a retained worker receives another execution', async () => {
    const fixture = create();
    await expect(fixture.reader.getState({ request: request('finance') })).resolves.toBe('paused');
    fixture.finance.get.mockResolvedValue({
      id: SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_ID,
      type: SIGNIFICANT_EVENTS_MAINTENANCE_STATE_SO_TYPE,
      attributes: { state: 'enabled' },
      references: [],
    });
    await expect(fixture.reader.getState({ request: request('finance') })).resolves.toBe('enabled');
    expect(fixture.finance.get).toHaveBeenCalledTimes(2);
  });

  it('propagates failed state reads instead of allowing onboarding', async () => {
    const fixture = create();
    const error = new Error('Storage unavailable');
    fixture.sales.get.mockRejectedValue(error);
    await expect(fixture.reader.getState({ request: request('sales') })).rejects.toBe(error);
  });
});
