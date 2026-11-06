/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Client } from '@elastic/elasticsearch';
import { readFileSync } from 'fs';
import { createServer as createHttpsServer } from 'https';
import type { Server as HttpsServer } from 'https';
import type { AddressInfo } from 'net';
import type { TLSSocket } from 'tls';

import type { CoreStart } from '@kbn/core/server';
import { PluginType } from '@kbn/core-base-common';
import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { TaskStaticPlugin } from '@kbn/core-plugins-server-internal';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import {
  CA_CERT_PATH,
  ES_CERT_PATH,
  ES_KEY_PATH,
  KBN_CERT_PATH,
  KBN_KEY_PATH,
} from '@kbn/dev-utils';
import { getLicenseFetcher } from '@kbn/licensing-plugin/server/license_fetcher';
import { kibanaPackageJson } from '@kbn/repo-info';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import type { TaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { defineTaskType } from '@kbn/task-manager-plugin/server/task_type_module';

import { ConfigSchema, createConfig } from '../config';
import {
  registerServiceAccountCredentialSavedObjectType,
  registerWorkloadBindingSavedObjectType,
} from '../service_accounts';
import type { SecurityTaskPluginStart } from '../task_plugin';
import { createSecurityTaskPlugin, getTaskProcessSettings } from '../task_plugin';

const KIBANA_VERSION = kibanaPackageJson.version;

interface CoreServiceAccountsStart {
  serviceAccounts: CoreStart['security']['serviceAccounts'];
}

const ENCRYPTION_KEY = 'a'.repeat(32);

// A plugin that owns a workload type, as the workflows engine does: Core scopes the workload methods of
// service accounts to the plugin that registered the type, so this is what a run binds and assumes with.
const workloadsPlugin: TaskStaticPlugin = {
  manifest: {
    id: 'securityTestWorkloads',
    version: KIBANA_VERSION,
    kibanaVersion: KIBANA_VERSION,
    type: PluginType.standard,
    configPath: ['securityTestWorkloads'],
    requiredPlugins: [],
    optionalPlugins: [],
    requiredBundles: [],
    runtimePluginDependencies: [],
    server: true,
    ui: false,
    owner: { name: 'Kibana Security', githubTeam: 'kibana-security' },
  },
  definition: {
    taskPlugin: async () => ({
      setup(core) {
        core.security.serviceAccounts.registerWorkloadType({ type: 'job', name: 'Job' });
      },
      start(core) {
        return { serviceAccounts: core.security.serviceAccounts };
      },
    }),
  },
};

// A module that wants service accounts declares encrypted saved objects, which is what runs the
// encrypted saved objects plugin in its process.
const serviceAccountsTaskModule = defineTaskType({
  type: 'security:integration-test-service-accounts',
  title: 'Security service accounts integration test',
  taskPlugins: [createSecurityTaskPlugin(KIBANA_VERSION), workloadsPlugin],
  encryptedSavedObjectTypes: [
    { type: 'security-test-encrypted', attributesToEncrypt: new Set(['secret']) },
  ],
  createTaskRunner: () => ({ run: async () => ({ state: {} }) }),
});

const taskModule = defineTaskType({
  type: 'security:integration-test',
  title: 'Security integration test',
  taskPlugins: [createSecurityTaskPlugin(KIBANA_VERSION)],
  createTaskRunner: () => ({ run: async () => ({ state: {} }) }),
});

/**
 * Boots Core with the security task plugin as a static plugin, as a task process does, against a real
 * Elasticsearch: what a run gets from Core and from `host.plugins.security` is the plugin's own
 * implementation of API keys, privilege checks and audit.
 */
describe('the security plugin in a task process', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let core: TaskProcessCore | undefined;
  let basicAuthorization: string;

  const boot = async (
    uiam?: Record<string, unknown>,
    {
      serviceAccounts = false,
      serverless = false,
      cloudProjectContext,
    }: {
      serviceAccounts?: boolean;
      serverless?: boolean;
      cloudProjectContext?: { organizationId: string; projectId: string; projectType: never };
    } = {}
  ) => {
    const license = await getLicenseFetcher({
      clusterClient: { asInternalUser: es } as never,
      logger: loggingSystemMock.create().get() as never,
      cacheDurationMs: 0,
      maxRetryDelay: 1000,
    })();
    const config = createConfig(
      ConfigSchema.validate(
        {
          audit: { enabled: false },
          ...(uiam ? { uiam } : {}),
          ...(serviceAccounts ? { serviceAccounts: { enabled: true } } : {}),
        },
        { serverless: !!uiam }
      ),
      loggingSystemMock.create().get(),
      { isTLSEnabled: false }
    );
    core = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: elasticsearchConfigFromEnv({
          ES_URL: esServer.hosts[0],
          ES_USERNAME: esServer.username,
          ES_PASSWORD: esServer.password,
        }),
        kibanaVersion: KIBANA_VERSION,
        authToken: '',
        server: {
          uuid: '5b2de169-2785-441b-ae8c-186a1936b17d',
          buildNum: 1,
          isServerless: serverless,
        },
        ...(serviceAccounts
          ? { encryptedSavedObjects: { encryptionKey: ENCRYPTION_KEY, decryptionOnlyKeys: [] } }
          : {}),
        settings: {
          security: serializeSettings(
            getTaskProcessSettings({
              license,
              config,
              applicationName: 'kibana-.kibana',
              kibanaServerResourceURL: 'http://localhost:5601',
              cloudProjectContext,
            })
          ),
        },
      },
      module: serviceAccounts ? serviceAccountsTaskModule : taskModule,
    });
    return core;
  };

  const basicRequest = () =>
    kibanaRequestFactory({ headers: { authorization: basicAuthorization } });

  // What Kibana's saved object migrations create: the index of the two hidden types.
  const createKibanaIndex = async () => {
    const types: Array<{ name: string; mappings: { properties: Record<string, unknown> } }> = [];
    const registrar = { registerType: (type: never) => types.push(type) } as never;
    const eso = { registerType: () => {} } as never;
    registerWorkloadBindingSavedObjectType(registrar, eso);
    registerServiceAccountCredentialSavedObjectType(registrar, eso);
    await es.indices.create({
      index: `.kibana_${KIBANA_VERSION}_001`,
      aliases: { '.kibana': {}, [`.kibana_${KIBANA_VERSION}`]: {} },
      mappings: {
        dynamic: false,
        properties: {
          type: { type: 'keyword' },
          namespace: { type: 'keyword' },
          namespaces: { type: 'keyword' },
          updated_at: { type: 'date' },
          references: { type: 'nested' },
          ...Object.fromEntries(
            types.map(({ name, mappings }) => [name, { properties: mappings.properties }])
          ),
        },
      } as never,
    });
  };

  // A user who manages security: Kibana's own user may not, and a process has no session, so the user is
  // what Kibana's authenticator puts on the request.
  const ADMIN = { username: 'sa-admin', password: 'changeme-password' };
  const adminRequest = () => {
    const request = kibanaRequestFactory({
      headers: {
        authorization: `Basic ${Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString(
          'base64'
        )}`,
      },
    });
    Object.defineProperty(request, 'auth', {
      configurable: true,
      value: {
        isAuthenticated: true,
        credentials: {
          username: ADMIN.username,
          roles: ['superuser'],
          enabled: true,
          authentication_realm: { name: 'default_native', type: 'native' },
          lookup_realm: { name: 'default_native', type: 'native' },
          authentication_provider: { type: 'basic', name: 'basic' },
          authentication_type: 'realm',
          elastic_cloud_user: false,
          metadata: {},
        },
      },
    });
    return request;
  };

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial', esArgs: ['xpack.security.authc.token.enabled=true'] } },
    });
    esServer = await startES();
    es = esServer.es.getClient();
    await createKibanaIndex();
    await es.security.putUser({ ...ADMIN, roles: ['superuser'] });
    basicAuthorization = `Basic ${Buffer.from(`${esServer.username}:${esServer.password}`).toString(
      'base64'
    )}`;
  });

  afterEach(async () => {
    await core?.stop();
    core = undefined;
  });

  afterAll(async () => {
    await esServer?.stop();
  });

  it('gives Core the security plugin API keys, which work against Elasticsearch', async () => {
    const { host } = await boot();
    const { apiKeys } = host.security.authc;

    expect(await apiKeys.areAPIKeysEnabled()).toBe(true);
    expect(apiKeys.uiam).toBeNull();

    // Created as the user of the request.
    const created = await apiKeys.create(basicRequest(), { name: 'created', role_descriptors: {} });
    expect(created).toEqual(
      expect.objectContaining({ name: 'created', api_key: expect.any(String) })
    );

    // Granted to the internal user from the credentials of the request.
    const granted = await apiKeys.grantAsInternalUser(basicRequest(), {
      name: 'granted',
      role_descriptors: {},
    });
    expect(granted).toEqual(expect.objectContaining({ name: 'granted', id: expect.any(String) }));
    const { api_keys: found } = await es.security.getApiKey({ id: granted!.id });
    expect(found[0].name).toBe('granted');

    // Cloned from the API key the request carries.
    const apiKeyRequest = kibanaRequestFactory({
      headers: {
        authorization: `ApiKey ${Buffer.from(`${granted!.id}:${granted!.api_key}`).toString(
          'base64'
        )}`,
      },
    });
    const cloned = await apiKeys.cloneAsInternalUser(apiKeyRequest, { name: 'cloned' });
    expect(cloned).toEqual(expect.objectContaining({ id: expect.any(String) }));

    // Invalidated.
    const result = await apiKeys.invalidate(basicRequest(), {
      ids: [created!.id, granted!.id, cloned!.id],
    });
    expect(result?.invalidated_api_keys).toHaveLength(3);
  });

  it('returns the authc, authz and audit contracts to the modules', async () => {
    const { host } = await boot();
    const security = host.plugins!.security as SecurityTaskPluginStart;

    expect(await security.authc.apiKeys.areAPIKeysEnabled()).toBe(true);
    expect(security.audit.withoutRequest.enabled).toBe(false);

    const privileges = await security.authz
      .checkPrivilegesWithRequest(basicRequest())
      .atSpace('default', { kibana: [security.authz.actions.login] });
    expect(privileges.username).toBe(esServer.username);
    // The privileges of Kibana are registered by Kibana, not by a process, so none are granted.
    expect(privileges.hasAllRequested).toBe(false);
  });

  it('exposes the UIAM API keys of the plugin when UIAM is enabled', async () => {
    const { host } = await boot({
      enabled: true,
      url: 'https://uiam.invalid',
      sharedSecret: 'a-shared-secret',
    });

    expect(host.security.authc.apiKeys.uiam).not.toBeNull();
    expect(typeof host.security.authc.apiKeys.uiam!.grant).toBe('function');
  });

  it('authorizes the saved objects a scoped client reads with the privileges of the request', async () => {
    const { host } = await boot();
    // Kibana registers its privileges in Elasticsearch when it starts, which a process does not.
    await es.security.putPrivileges({
      privileges: {
        'kibana-.kibana': {
          read_config: { actions: ['saved_object:config/get'] },
        },
      },
    });
    await es.security.putRole({
      name: 'config-reader',
      applications: [
        {
          application: 'kibana-.kibana',
          privileges: ['read_config'],
          resources: ['space:default'],
        },
      ],
    });
    const login = (username: string) => ({
      authorization: `Basic ${Buffer.from(`${username}:changeme-password`).toString('base64')}`,
    });
    await es.security.putUser({
      username: 'config-reader-user',
      password: 'changeme-password',
      roles: ['config-reader'],
    });
    await es.security.putUser({
      username: 'no-kibana-access',
      password: 'changeme-password',
      roles: [],
    });

    // A user who may read the type is not refused, the object is just not there: it was authorized.
    await expect(
      host.savedObjects
        .getScopedClient(kibanaRequestFactory({ headers: login('config-reader-user') }))
        .get('config', 'not-there')
    ).rejects.toMatchObject({ output: { statusCode: 404 } });
    // A user without privileges on the type is refused, as Kibana would.
    await expect(
      host.savedObjects
        .getScopedClient(kibanaRequestFactory({ headers: login('no-kibana-access') }))
        .get('config', 'not-there')
    ).rejects.toMatchObject({ output: { statusCode: 403 } });
  });
  describe('service accounts of the Elasticsearch backend', () => {
    it('creates an account, binds a workload and runs it as the account, through the delegate', async () => {
      const { host } = await boot(undefined, { serviceAccounts: true });
      const { serviceAccounts } = host.plugins!.security as SecurityTaskPluginStart;
      const workloads = (host.plugins!.securityTestWorkloads as CoreServiceAccountsStart)
        .serviceAccounts;
      expect(serviceAccounts).not.toBeNull();
      expect(workloads.isEnabled()).toBe(true);

      // Kibana registers its privileges when it starts, and managing service accounts is checked with the login action.
      await es.security.putPrivileges({
        privileges: { 'kibana-.kibana': { all: { actions: ['login:'] } } },
      });
      await es.security.putRole({
        name: 'sa-role',
        cluster: ['monitor'],
        indices: [{ names: ['sa-*'], privileges: ['all'] }],
      });
      const request = adminRequest();
      const account = await serviceAccounts!.backend.create(request, {
        name: 'process-runner',
        roles: ['sa-role'],
      });
      expect(account.id).toBe('kibana/process-runner');
      await serviceAccounts!.workloads.bindWorkload('securityTestWorkloads', request, {
        serviceAccountId: account.id,
        workloadType: 'job',
        workloadId: 'job-1',
      });

      // Read back through the delegate, as an engine run reads it.
      expect(
        await workloads.getWorkloadBinding({
          workloadType: 'job',
          workloadId: 'job-1',
          spaceId: 'default',
        })
      ).toEqual(expect.objectContaining({ serviceAccountId: account.id }));

      const authenticated = await workloads.withScopedRequestForWorkload(
        {
          workloadType: 'job',
          workloadId: 'job-1',
          spaceId: 'default',
          expectedServiceAccountId: account.id,
        },
        async (scoped) => {
          const client = host.elasticsearch.asScoped(scoped).asCurrentUser;
          await client.index({ index: 'sa-docs', document: { by: 'process' }, refresh: true });
          return await client.security.authenticate();
        }
      );
      expect(authenticated.username).toBe('kibana/process-runner');
      expect(authenticated.authentication_type).toBe('token');
      // The credential the process minted is not part of anything it returns.
      expect(JSON.stringify(authenticated)).not.toMatch(/AAE[A-Za-z0-9_-]{20}/);
    });

    it('refuses a workload that is not bound, without running it', async () => {
      const { host } = await boot(undefined, { serviceAccounts: true });
      const { serviceAccounts: workloads } = host.plugins!
        .securityTestWorkloads as CoreServiceAccountsStart;
      const fn = jest.fn();
      await expect(
        workloads.withScopedRequestForWorkload(
          { workloadType: 'job', workloadId: 'unbound', spaceId: 'default' },
          fn
        )
      ).rejects.toMatchObject({ output: { statusCode: 404 } });
      expect(fn).not.toHaveBeenCalled();
    });
  });
  describe('service accounts of the UIAM backend', () => {
    let uiamServer: HttpsServer;
    let uiamUrl: string;
    const exchanges: Array<{ url?: string; clientCertificate?: string; authorized: boolean }> = [];

    beforeAll(async () => {
      // A UIAM that requires the mTLS client certificate of Kibana, which identifies its project.
      uiamServer = createHttpsServer(
        {
          key: readFileSync(ES_KEY_PATH),
          cert: readFileSync(ES_CERT_PATH),
          ca: readFileSync(CA_CERT_PATH),
          requestCert: true,
          rejectUnauthorized: true,
        },
        (req, res) => {
          const socket = req.socket as TLSSocket;
          exchanges.push({
            url: req.url,
            clientCertificate: socket.getPeerCertificate()?.subject?.CN,
            authorized: socket.authorized,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token: 'essu_minted_by_the_mock_uiam', expires_in: 'PT5M' }));
        }
      );
      await new Promise<void>((resolve) => uiamServer.listen(0, '127.0.0.1', resolve));
      uiamUrl = `https://127.0.0.1:${(uiamServer.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => uiamServer?.close(resolve));
    });

    it('obtains the credentials of a bound workload from UIAM, with the mTLS material it was sent', async () => {
      const { host } = await boot(
        {
          enabled: true,
          url: uiamUrl,
          sharedSecret: 'a-shared-secret',
          // Paths that the process is not sent: it gets what the files hold.
          ssl: {
            verificationMode: 'certificate',
            certificate: KBN_CERT_PATH,
            key: KBN_KEY_PATH,
            certificateAuthorities: [CA_CERT_PATH],
          },
        },
        {
          serviceAccounts: true,
          serverless: true,
          cloudProjectContext: {
            organizationId: 'org-1',
            projectId: 'project-1',
            projectType: 'security' as never,
          },
        }
      );
      const { serviceAccounts } = host.plugins!.security as SecurityTaskPluginStart;
      const workloads = (host.plugins!.securityTestWorkloads as CoreServiceAccountsStart)
        .serviceAccounts;
      expect(serviceAccounts).not.toBeNull();

      // Bindings are saved objects the process reads as Kibana wrote them.
      await serviceAccounts!.workloads.bindWorkload('securityTestWorkloads', adminRequest(), {
        serviceAccountId: 'uiam-account-1',
        workloadType: 'job',
        workloadId: 'uiam-job',
      });

      const authorization = await workloads.withScopedRequestForWorkload(
        {
          workloadType: 'job',
          workloadId: 'uiam-job',
          spaceId: 'default',
          expectedServiceAccountId: 'uiam-account-1',
        },
        async (scoped) => scoped.headers.authorization
      );

      expect(exchanges).toEqual([
        expect.objectContaining({
          url: '/uiam/api/v1/service-accounts/uiam-account-1/credentials/_exchange',
          authorized: true,
          clientCertificate: expect.any(String),
        }),
      ]);
      expect(authorization).toBe('Bearer essu_minted_by_the_mock_uiam');
    });
  });
});
