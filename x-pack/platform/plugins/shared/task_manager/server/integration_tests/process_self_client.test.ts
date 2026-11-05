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

import { createServer } from 'http';
import type { IncomingHttpHeaders, Server } from 'http';
import type { AddressInfo } from 'net';
import { kibanaPackageJson } from '@kbn/repo-info';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import { elasticsearchConfigFromEnv } from '../task_process/es_config';
import { startTaskProcessCore } from '../task_process/core_process';
import type { TaskProcessCore } from '../task_process/core_process';
import { defineTaskType } from '../task_type_module';
import { buildTaskFakeRequest } from '../task_running/fake_request_factory';

/**
 * A task process has no HTTP listener, but a run may call Kibana's own APIs (workflow steps do): the
 * host's self client calls the Kibana that dispatched the run, at the address it sent, with the credential
 * of the run's request.
 */
describe('the self client of a task process', () => {
  let esServer: TestElasticsearchUtils;
  let kibana: Server;
  let core: TaskProcessCore;
  const received: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();

    // The Kibana that dispatched the run, as far as the self client can tell.
    kibana = createServer((req, res) => {
      received.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'kibana' }));
    });
    await new Promise<void>((resolve) => kibana.listen(0, '127.0.0.1', resolve));
    const { port } = kibana.address() as AddressInfo;

    core = await startTaskProcessCore({
      init: {
        kind: 'init',
        elasticsearch: elasticsearchConfigFromEnv({
          ES_URL: esServer.hosts[0],
          ES_USERNAME: esServer.username,
          ES_PASSWORD: esServer.password,
        }),
        kibanaVersion: kibanaPackageJson.version,
        authToken: '',
        server: {
          uuid: '5b2de169-2785-441b-ae8c-186a1936b17d',
          buildNum: 1,
          isServerless: false,
          publicBaseUrl: `http://127.0.0.1:${port}`,
        },
      },
      module: defineTaskType({
        type: 'test:self_client',
        title: 'Self client',
        createTaskRunner: () => ({ run: async () => ({ state: {} }) }),
      }),
    });
  });

  afterAll(async () => {
    await core?.stop();
    await new Promise((resolve) => kibana?.close(resolve));
    await esServer?.stop();
  });

  it('calls Kibana with the credential of the run and the internal origin', async () => {
    const fakeRequest = buildTaskFakeRequest({ apiKey: 'a-run-api-key', spaceId: 'default' });

    const response = await core.host.http.selfClient
      .asScoped(fakeRequest)
      .fetch<{ from: string }>('/internal/some/route', { access: 'internal' });

    expect(response).toEqual({ from: 'kibana' });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/internal/some/route');
    expect(received[0].headers.authorization).toBe('ApiKey a-run-api-key');
    expect(received[0].headers['x-elastic-internal-origin']).toBe('Kibana');
  });

  it('prefixes the space of the run', async () => {
    received.length = 0;
    const fakeRequest = buildTaskFakeRequest({ apiKey: 'a-run-api-key', spaceId: 'other' });

    await core.host.http.selfClient.asScoped(fakeRequest).fetch('/api/thing', {});

    expect(received[0].url).toBe('/s/other/api/thing');
  });
});
