/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import { loggerMock } from '@kbn/logging-mocks';
import { Actions } from '@kbn/security-authorization-core';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { createFieldsMetadataCapabilities } from './create_fields_metadata_capabilities';

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
const create = (definitions = features) => {
  const security = securityMock.createStart();
  security.authz.actions = new Actions();
  security.authz.mode.useRbacForRequest.mockReturnValue(true);
  security.authc.getCurrentUser.mockReturnValue(null);
  const privileges = (authorized: boolean) => ({
    privileges: {
      kibana: ['fleet', 'fleetv2'].map((id) => ({
        resource: 'space:default',
        privilege: security.authz.actions.ui.get(id, 'read'),
        authorized,
      })),
      elasticsearch: { cluster: [], index: {} },
    },
  });
  const check = jest.fn().mockResolvedValue(privileges(true));
  security.authz.checkPrivilegesDynamicallyWithRequest.mockReturnValue(check);
  const getActiveSpace = jest
    .fn()
    .mockResolvedValue({ id: 'default', name: 'Default', disabledFeatures: [] });
  const getCapabilities = createFieldsMetadataCapabilities({
    features: definitions,
    authz: security.authz,
    getCurrentUser: security.authc.getCurrentUser,
    getActiveSpace,
    logger: loggerMock.create(),
  });
  return { getCapabilities, getActiveSpace, check, privileges };
};
const request = (key: string) =>
  kibanaRequestFactory({ headers: { authorization: `ApiKey ${key}` } });

describe('field metadata capability composition', () => {
  it('rechecks identity on every request without retaining another caller’s grants', async () => {
    const fixture = create();
    const allowed = request('first-user');
    const denied = request('second-user');
    const first = await fixture.getCapabilities(allowed);
    expect(first).toEqual({ fleet: { read: true }, fleetv2: { read: true } });
    fixture.check.mockResolvedValue(fixture.privileges(false));
    await expect(fixture.getCapabilities(denied)).resolves.toEqual({
      fleet: { read: false },
      fleetv2: { read: false },
    });
    expect(first).toEqual({ fleet: { read: true }, fleetv2: { read: true } });
    expect(fixture.getActiveSpace.mock.calls).toEqual([[allowed], [denied]]);
    expect(fixture.check).toHaveBeenCalledTimes(2);
  });

  it('applies the native space-disabled feature gate after authorization and observes later changes', async () => {
    const fixture = create();
    fixture.getActiveSpace.mockResolvedValueOnce({
      id: 'default',
      name: 'Default',
      disabledFeatures: ['fleet'],
    });
    await expect(fixture.getCapabilities(request('valid'))).resolves.toEqual({
      fleet: { read: false },
      fleetv2: { read: true },
    });
    await expect(fixture.getCapabilities(request('valid'))).resolves.toEqual({
      fleet: { read: true },
      fleetv2: { read: true },
    });
  });

  it('does not invent capabilities when Fleet has registered no feature definitions', async () => {
    const fixture = create([]);
    await expect(fixture.getCapabilities(request('valid'))).resolves.toEqual({
      fleet: undefined,
      fleetv2: undefined,
    });
    expect(fixture.check).not.toHaveBeenCalled();
    expect(fixture.getActiveSpace).not.toHaveBeenCalled();
  });
});
