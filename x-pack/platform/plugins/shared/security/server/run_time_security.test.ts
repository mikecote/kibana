/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  elasticsearchServiceMock,
  httpServerMock,
  loggingSystemMock,
} from '@kbn/core/server/mocks';

import { createRunTimeSecurity } from './run_time_security';
import type { RunTimeSecurityOptions } from './run_time_security';
import { UiamService } from './uiam/uiam_service';
import { uiamServiceMock } from './uiam/uiam_service.mock';
import { licenseMock } from '../common/licensing/index.mock';

jest.mock('./uiam/uiam_service', () => ({ UiamService: jest.fn() }));

describe('createRunTimeSecurity', () => {
  let clusterClient: ReturnType<typeof elasticsearchServiceMock.createClusterClient>;
  let scoped: ReturnType<typeof elasticsearchServiceMock.createScopedClusterClient>;
  let uiam: ReturnType<typeof uiamServiceMock.create>;
  const audit = { asScoped: jest.fn(), withoutRequest: { log: jest.fn() } } as never;

  const create = (overrides: Partial<RunTimeSecurityOptions> = {}) => {
    const license = licenseMock.create();
    license.isEnabled.mockReturnValue(true);
    return createRunTimeSecurity({
      logger: loggingSystemMock.create(),
      clusterClient,
      license,
      config: { serviceAccounts: { enabled: false } },
      applicationName: 'kibana-.kibana',
      audit,
      getCurrentUser: () => null,
      ...overrides,
    });
  };

  beforeEach(() => {
    clusterClient = elasticsearchServiceMock.createClusterClient();
    scoped = elasticsearchServiceMock.createScopedClusterClient();
    clusterClient.asScoped.mockReturnValue(scoped);
    uiam = uiamServiceMock.create();
    (UiamService as jest.Mock).mockReset().mockImplementation(() => uiam);
  });

  it('returns the audit service it was given', () => {
    expect(create().audit).toBe(audit);
  });

  describe('without UIAM', () => {
    it('has no UIAM API keys and does not build the UIAM service', () => {
      expect(create().authc.apiKeys.uiam).toBeNull();
      expect(UiamService).not.toHaveBeenCalled();
    });

    it('creates API keys as the user of the request', async () => {
      scoped.asCurrentUser.security.createApiKey.mockResponse({
        id: 'id',
        name: 'name',
        api_key: 'secret',
      } as never);
      const { authc } = create();

      const result = await authc.apiKeys.create(httpServerMock.createKibanaRequest(), {
        name: 'name',
        role_descriptors: {},
      });

      expect(result).toEqual(expect.objectContaining({ id: 'id', api_key: 'secret' }));
      expect(clusterClient.asScoped).toHaveBeenCalled();
    });

    it('grants an API key to the internal user from the credentials of the request', async () => {
      clusterClient.asInternalUser.security.grantApiKey.mockResponse({
        id: 'id',
        name: 'name',
        api_key: 'secret',
      } as never);
      const { authc } = create();

      await authc.apiKeys.grantAsInternalUser(
        httpServerMock.createKibanaRequest({ headers: { authorization: 'Basic dTpw' } }),
        { name: 'name', role_descriptors: {} }
      );

      expect(clusterClient.asInternalUser.security.grantApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          grant_type: 'password',
          username: 'u',
          password: 'p',
          api_key: expect.objectContaining({ name: 'name' }),
        })
      );
    });

    it('clones an API key', async () => {
      clusterClient.asInternalUser.transport.request.mockResolvedValue({ id: 'new' } as never);
      const { authc } = create();

      const result = await authc.apiKeys.cloneAsInternalUser(
        httpServerMock.createKibanaRequest({ headers: { authorization: 'ApiKey abc' } }),
        { name: 'clone' }
      );

      expect(result).toEqual({ id: 'new' });
      expect(clusterClient.asInternalUser.transport.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', path: '/_security/api_key/clone' })
      );
    });

    it('returns null for API key operations when the license disables security', async () => {
      const license = licenseMock.create();
      license.isEnabled.mockReturnValue(false);
      const { authc } = create({ license });

      expect(
        await authc.apiKeys.cloneAsInternalUser(
          httpServerMock.createKibanaRequest({ headers: { authorization: 'ApiKey abc' } }),
          { name: 'clone' }
        )
      ).toBeNull();
    });
  });

  describe('with UIAM', () => {
    const uiamConfig = {
      enabled: true,
      url: 'https://uiam.test',
      sharedSecret: 'secret',
      ssl: { verificationMode: 'full' as const },
    };
    const uiamOptions = { kibanaServerResourceURL: 'https://kibana.test', kibanaVersion: '9.5.0' };

    it('builds the UIAM service from the config and exposes UIAM API keys', async () => {
      const { authc } = create({
        config: { uiam: uiamConfig, serviceAccounts: { enabled: false } },
        uiam: uiamOptions,
      });

      expect(UiamService).toHaveBeenCalledWith(expect.anything(), uiamConfig, uiamOptions);
      expect(authc.apiKeys.uiam).not.toBeNull();

      uiam.grantApiKey.mockResolvedValue({
        id: 'id',
        key: 'essu_new',
        description: 'name',
      } as never);
      const result = await authc.apiKeys.uiam!.grant(
        httpServerMock.createKibanaRequest({
          headers: { authorization: 'ApiKey essu_credential' },
        }),
        { name: 'name' }
      );
      expect(uiam.grantApiKey).toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ id: 'id', api_key: 'essu_new' }));
    });

    it('invalidates a UIAM API key through the UIAM service', async () => {
      const { authc } = create({
        config: { uiam: uiamConfig, serviceAccounts: { enabled: false } },
        uiam: uiamOptions,
      });

      await authc.apiKeys.uiam!.invalidate(
        httpServerMock.createKibanaRequest({
          headers: { authorization: 'ApiKey essu_credential' },
        }),
        { id: 'id' }
      );

      expect(uiam.revokeApiKey).toHaveBeenCalled();
    });

    it('requires the options of the UIAM service', () => {
      expect(() =>
        create({ config: { uiam: uiamConfig, serviceAccounts: { enabled: false } } })
      ).toThrow('UIAM is enabled but its server options were not given');
    });
  });

  describe('authz', () => {
    it('checks the privileges of the application of the given name', async () => {
      const { authz } = create();
      // Elasticsearch answers for every action and resource it was asked about.
      scoped.asCurrentUser.security.hasPrivileges.mockImplementation((async (body: any) => {
        const [{ application, resources, privileges }] = body.application;
        return {
          username: 'u',
          has_all_requested: true,
          cluster: {},
          index: {},
          application: {
            [application]: Object.fromEntries(
              resources.map((resource: string) => [
                resource,
                Object.fromEntries(privileges.map((privilege: string) => [privilege, true])),
              ])
            ),
          },
        };
      }) as never);
      const checkPrivileges = authz.checkPrivilegesWithRequest(
        httpServerMock.createKibanaRequest()
      );
      await checkPrivileges.atSpace('default', {
        kibana: [authz.actions.ui.get('foo', 'bar')],
      });

      expect(scoped.asCurrentUser.security.hasPrivileges).toHaveBeenCalledWith(
        expect.objectContaining({
          application: [expect.objectContaining({ application: 'kibana-.kibana' })],
        })
      );
    });

    it('checks privileges dynamically in the space of the request, which connector authorization needs', async () => {
      const { authz } = create();
      scoped.asCurrentUser.security.hasPrivileges.mockImplementation((async (body: any) => {
        const [{ application, resources, privileges }] = body.application;
        return {
          username: 'u',
          has_all_requested: false,
          cluster: {},
          index: {},
          application: {
            [application]: Object.fromEntries(
              resources.map((resource: string) => [
                resource,
                Object.fromEntries(privileges.map((privilege: string) => [privilege, false])),
              ])
            ),
          },
        };
      }) as never);
      const request = Object.assign(httpServerMock.createKibanaRequest(), { spaceId: 'other' });

      const { hasAllRequested } = await authz.checkPrivilegesDynamicallyWithRequest(request)({
        kibana: ['saved_object:action/get'],
      });

      expect(hasAllRequested).toBe(false);
      expect(scoped.asCurrentUser.security.hasPrivileges).toHaveBeenCalledWith(
        expect.objectContaining({
          application: [expect.objectContaining({ resources: ['space:other'] })],
        })
      );
    });
  });
});
