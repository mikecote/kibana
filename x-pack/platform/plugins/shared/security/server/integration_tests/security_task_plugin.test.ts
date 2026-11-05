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

import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import { getLicenseFetcher } from '@kbn/licensing-plugin/server/license_fetcher';
import { kibanaPackageJson } from '@kbn/repo-info';
import { startTaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import type { TaskProcessCore } from '@kbn/task-manager-plugin/server/task_process/core_process';
import { elasticsearchConfigFromEnv } from '@kbn/task-manager-plugin/server/task_process/es_config';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { defineTaskType } from '@kbn/task-manager-plugin/server/task_type_module';

import { ConfigSchema, createConfig } from '../config';
import type { SecurityTaskPluginStart } from '../task_plugin';
import { createSecurityTaskPlugin, getTaskProcessSettings } from '../task_plugin';

const KIBANA_VERSION = kibanaPackageJson.version;

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

  const boot = async (uiam?: Record<string, unknown>) => {
    const license = await getLicenseFetcher({
      clusterClient: { asInternalUser: es } as never,
      logger: loggingSystemMock.create().get() as never,
      cacheDurationMs: 0,
      maxRetryDelay: 1000,
    })();
    const config = createConfig(
      ConfigSchema.validate(
        { audit: { enabled: false }, ...(uiam ? { uiam } : {}) },
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
        server: { uuid: '5b2de169-2785-441b-ae8c-186a1936b17d', buildNum: 1, isServerless: false },
        settings: {
          security: serializeSettings(
            getTaskProcessSettings({
              license,
              config,
              applicationName: 'kibana-.kibana',
              kibanaServerResourceURL: 'http://localhost:5601',
            })
          ),
        },
      },
      module: taskModule,
    });
    return core;
  };

  const basicRequest = () =>
    kibanaRequestFactory({ headers: { authorization: basicAuthorization } });

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();
    es = esServer.es.getClient();
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
});
