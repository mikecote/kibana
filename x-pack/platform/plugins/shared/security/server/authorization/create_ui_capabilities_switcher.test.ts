/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Capabilities } from '@kbn/core/server';
import { httpServerMock } from '@kbn/core/server/mocks';
import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import { KibanaFeature } from '@kbn/features-plugin/server';
import { loggerMock } from '@kbn/logging-mocks';
import { Actions } from '@kbn/security-authorization-core';

import { createSecurityCapabilitiesSwitcher } from './create_ui_capabilities_switcher';
import { authorizationMock } from './index.mock';

const feature = new KibanaFeature({
  id: 'fleet',
  name: 'Fleet',
  category: { id: 'management', label: 'Management' },
  app: ['fleet'],
  privileges: {
    all: { app: ['fleet'], savedObject: { all: [], read: [] }, ui: ['read'] },
    read: { app: ['fleet'], savedObject: { all: [], read: [] }, ui: ['read'] },
  },
});
const capabilities: Capabilities = {
  navLinks: {},
  management: {},
  catalogue: {},
  fleet: { read: true },
};
const create = (authorized = true) => {
  const authz = authorizationMock.create();
  authz.actions = new Actions();
  authz.mode.useRbacForRequest.mockReturnValue(true);
  const check = jest.fn().mockResolvedValue({
    privileges: {
      kibana: [
        { resource: 'space:default', privilege: authz.actions.ui.get('fleet', 'read'), authorized },
      ],
      elasticsearch: { cluster: [], index: {} },
    },
  });
  authz.checkPrivilegesDynamicallyWithRequest.mockReturnValue(check);
  const switcher = createSecurityCapabilitiesSwitcher({
    authz,
    getKibanaFeatures: () => [feature],
    getElasticsearchFeatures: () => [],
    getCurrentUser: () => null,
    logger: loggerMock.create(),
  });
  return { authz, check, switcher };
};

describe('security capability execution switcher', () => {
  it.each([true, false])(
    'uses real privilege evaluation for credential-bearing task requests (authorized: %s)',
    async (authorized) => {
      const { authz, check, switcher } = create(authorized);
      const request = kibanaRequestFactory({ headers: { authorization: 'ApiKey task-key' } });
      expect(request.isFakeRequest).toBe(true);
      expect(request.auth.isAuthenticated).toBe(false);
      await expect(switcher(request, capabilities, false)).resolves.toEqual({
        ...capabilities,
        fleet: { read: authorized },
      });
      expect(authz.checkPrivilegesDynamicallyWithRequest).toHaveBeenCalledWith(request);
      expect(check).toHaveBeenCalledWith({
        kibana: [authz.actions.ui.get('fleet', 'read')],
        elasticsearch: { cluster: [], index: {} },
      });
    }
  );

  it('denies an uncredentialed fake request without borrowing the internal Elasticsearch identity', async () => {
    const { check, switcher } = create();
    const request = kibanaRequestFactory({ headers: {} });
    await expect(switcher(request, capabilities, false)).resolves.toEqual({
      ...capabilities,
      fleet: { read: false },
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('keeps unauthenticated HTTP requests denied even when they contain an authorization header', async () => {
    const { check, switcher } = create();
    const request = httpServerMock.createKibanaRequest({
      auth: { isAuthenticated: false },
      headers: { authorization: 'ApiKey rejected-by-http' },
    });
    expect(request.isFakeRequest).toBe(false);
    await expect(switcher(request, capabilities, false)).resolves.toEqual({
      ...capabilities,
      fleet: { read: false },
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('denies revoked task credentials through native authorization error handling', async () => {
    const { check, switcher } = create();
    check.mockRejectedValue(Object.assign(new Error('Revoked key'), { statusCode: 401 }));
    const request = kibanaRequestFactory({ headers: { authorization: 'ApiKey revoked' } });
    await expect(switcher(request, capabilities, false)).resolves.toEqual({
      ...capabilities,
      fleet: { read: false },
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('propagates a backend failure instead of leaving capabilities enabled', async () => {
    const { check, switcher } = create();
    const error = Object.assign(new Error('Elasticsearch unavailable'), { statusCode: 503 });
    check.mockRejectedValue(error);
    const request = kibanaRequestFactory({ headers: { authorization: 'ApiKey valid' } });
    await expect(switcher(request, capabilities, false)).rejects.toBe(error);
  });

  it('preserves native behavior when the license disables RBAC', async () => {
    const { authz, check, switcher } = create();
    authz.mode.useRbacForRequest.mockReturnValue(false);
    await expect(
      switcher(kibanaRequestFactory({ headers: {} }), capabilities, false)
    ).resolves.toEqual({});
    expect(check).not.toHaveBeenCalled();
  });
});
