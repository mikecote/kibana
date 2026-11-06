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
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fetch as undiciFetch } from 'undici';
import { REPO_ROOT, kibanaPackageJson } from '@kbn/repo-info';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createTestServers } from '@kbn/core-test-helpers-kbn-server';
import type { TestElasticsearchUtils } from '@kbn/core-test-helpers-kbn-server';
import type { Client } from '@elastic/elasticsearch';
import { elasticsearchConfigFromEnv } from '../task_process/es_config';
import { RemoteTaskRunner } from '../task_process/remote_task_runner';
import type { TaskProcessLease } from '../task_process/remote_task_runner';
import { TaskProcessSupervisor } from '../task_process/supervisor';
import { serializeSettings } from '../task_process/settings';
import type { TaskProcessRunResponse } from '../task_process/wire';
import {
  FEATURE_NAME,
  SIDE_EFFECTS_TASK_TYPE,
  SIDE_EFFECT_EVENT_TYPE,
  USAGE_COUNTER_DOMAIN,
  USAGE_COUNTER_NAME,
} from './fixtures/side_effects.task';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildTaskBundle } = require(join(REPO_ROOT, 'src/dev/task_bundles/build'));

const KIBANA_VERSION = kibanaPackageJson.version;
const MAIN_INDEX = '.kibana';
const USAGE_COUNTERS_INDEX = '.kibana_usage_counters';

/**
 * A run in a task process does its side effects itself and finishes them before it answers, without
 * Kibana: the analytics event reaches the telemetry endpoint, the usage counter is stored, the feature
 * usage is written, and the response carries none of it. Only a real cluster and a real process
 * prove it, so the task type is bundled and forked by the supervisor as Kibana does.
 */
describe('side effects of a run in a task process', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let telemetryServer: Server;
  const received: Array<{ method?: string; body: string }> = [];

  const createIndex = (index: string, mappings: Record<string, unknown>) =>
    es.indices.create({
      index: `${index}_${KIBANA_VERSION}_001`,
      aliases: { [index]: {}, [`${index}_${KIBANA_VERSION}`]: {} },
      mappings: {
        dynamic: false,
        properties: { type: { type: 'keyword' }, updated_at: { type: 'date' }, ...mappings },
      },
    });

  beforeAll(async () => {
    telemetryServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => telemetryServer.listen(0, '127.0.0.1', resolve));
    const telemetryUrl = `http://127.0.0.1:${(telemetryServer.address() as AddressInfo).port}/ship`;

    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();
    es = esServer.es.getClient();

    // The indices Kibana's migrator would have created.
    await createIndex(MAIN_INDEX, {
      'licensing-feature-usage': { properties: { lastUsed: { type: 'date' } } },
    });
    await createIndex(USAGE_COUNTERS_INDEX, {
      'usage-counter': {
        properties: {
          domainId: { type: 'keyword' },
          counterName: { type: 'keyword' },
          counterType: { type: 'keyword' },
          source: { type: 'keyword' },
          count: { type: 'integer' },
        },
      },
    });

    const bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const built = await buildTaskBundle({
      entry: {
        pluginId: 'taskManager',
        name: 'taskManager__side_effects',
        file: join(__dirname, 'fixtures/side_effects.task.ts'),
      },
      outDir: bundleDir,
    });
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: {
          [built.name]: { file: `${built.name}.js`, taskType: SIDE_EFFECTS_TASK_TYPE },
        },
      })
    );

    supervisor = new TaskProcessSupervisor({
      settings: {
        bundle_dir: bundleDir,
        kibanaVersion: KIBANA_VERSION,
        getElasticsearchConfig: () =>
          elasticsearchConfigFromEnv({
            ES_URL: esServer.hosts[0],
            ES_USERNAME: esServer.username,
            ES_PASSWORD: esServer.password,
          }),
        // What the telemetry plugin, licensing and usage collection of Kibana send a process.
        getInitFor: () => ({
          settings: {
            telemetry: serializeSettings({
              optIn: true,
              sendUsageTo: 'staging',
              snapshotUrl: 'https://telemetry-staging.elastic.co/xpack/v2/send',
              labels: { branch: 'side-effects-test' },
              license: { uid: 'license-uid', status: 'active', type: 'trial' },
              shipperUrl: telemetryUrl,
            }),
            usageCollection: serializeSettings({
              usageCounters: { enabled: true, retryCount: 1, bufferDurationMs: 60_000 },
            }),
          },
        }),
      } as never,
      logger: loggingSystemMock.createLogger(),
    });
    supervisor.start();
  });

  afterAll(async () => {
    await supervisor?.stop();
    await esServer?.stop();
    await new Promise((resolve) => telemetryServer?.close(resolve));
  });

  it('ships the event, stores the counter and the feature usage before it answers, and returns none of it', async () => {
    const route = supervisor.getRoute(SIDE_EFFECTS_TASK_TYPE) as {
      acquire: () => Promise<TaskProcessLease>;
    };
    expect(route).toBeDefined();

    // The raw response, to prove that nothing but the result comes back.
    const lease = await route.acquire();
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    let body: TaskProcessRunResponse;
    try {
      response = await undiciFetch(`${lease.url}/run`, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.token}` },
        body: JSON.stringify({
          taskType: SIDE_EFFECTS_TASK_TYPE,
          taskInstance: {
            id: 'side-effects',
            taskType: SIDE_EFFECTS_TASK_TYPE,
            params: {},
            state: {},
          },
          executionUuid: 'side-effects-1',
          kibanaVersion: KIBANA_VERSION,
        }),
      });
      body = (await response.json()) as TaskProcessRunResponse;
    } finally {
      // The process of a run stops with it: what it did not finish before answering is lost.
      lease.release();
    }

    // (d) The response carries the result and nothing to apply.
    expect(response.status).toBe(200);
    expect(body).toEqual({ kind: 'result', result: { state: { done: true } } });

    // (a) The event reached the endpoint before the answer, so it is already there.
    const shipped = received
      .filter(({ method }) => method === 'POST')
      .flatMap(({ body: ndjson }) => ndjson.split('\n').filter(Boolean))
      .map(
        (line) =>
          JSON.parse(line) as Record<string, unknown> & {
            properties?: unknown;
            context?: unknown;
            event_type?: string;
          }
      )
      .filter((event) => event.event_type === SIDE_EFFECT_EVENT_TYPE);
    expect(shipped).toHaveLength(1);
    expect(shipped[0].properties).toEqual({ value: 42 });
    // With the context of Kibana's events.
    expect(shipped[0].context).toEqual(
      expect.objectContaining({
        labels: { branch: 'side-effects-test' },
        license_id: 'license-uid',
        license_type: 'trial',
        version: KIBANA_VERSION,
      })
    );

    // (b) The usage counter is stored, in the document Kibana's usage collection would use.
    await es.indices.refresh({ index: USAGE_COUNTERS_INDEX });
    const counters = await es.search<{ 'usage-counter': Record<string, unknown> }>({
      index: USAGE_COUNTERS_INDEX,
      query: { term: { 'usage-counter.domainId': USAGE_COUNTER_DOMAIN } },
    });
    expect(counters.hits.hits).toHaveLength(1);
    expect(counters.hits.hits[0]._source?.['usage-counter']).toEqual(
      expect.objectContaining({
        domainId: USAGE_COUNTER_DOMAIN,
        counterName: USAGE_COUNTER_NAME,
        counterType: 'count',
        source: 'server',
        count: 3,
      })
    );

    // (c) The feature usage is written to the store every node and process shares.
    const usage = await es.get<{ 'licensing-feature-usage': { lastUsed: string } }>({
      index: MAIN_INDEX,
      id: `licensing-feature-usage:${FEATURE_NAME}`,
    });
    expect(usage._source?.['licensing-feature-usage'].lastUsed).toBe('2026-01-02T03:04:05.000Z');
  });

  it('answers a second run too: the process is gone, so the first run could not have been flushed later', async () => {
    const result = await new RemoteTaskRunner({
      route: supervisor.getRoute(SIDE_EFFECTS_TASK_TYPE)!,
      request: {
        taskType: SIDE_EFFECTS_TASK_TYPE,
        taskInstance: {
          id: 'side-effects',
          taskType: SIDE_EFFECTS_TASK_TYPE,
          params: {},
          state: {},
        },
        executionUuid: 'side-effects-2',
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs: 30000,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: undiciFetch as unknown as typeof fetch,
    }).run();

    expect(result).toEqual({ state: { done: true } });
    // Counters are written without a refresh, as Kibana writes them.
    await es.indices.refresh({ index: USAGE_COUNTERS_INDEX });
    const counters = await es.search<{ 'usage-counter': { count: number } }>({
      index: USAGE_COUNTERS_INDEX,
      query: { term: { 'usage-counter.domainId': USAGE_COUNTER_DOMAIN } },
    });
    // The same counter and day: the second run added to the first one's.
    expect(counters.hits.hits[0]._source?.['usage-counter'].count).toBe(6);
  });
});
