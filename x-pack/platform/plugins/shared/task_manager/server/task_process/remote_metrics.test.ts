/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { sessionChannelPair } from './testing/session_channel';
import { WorkerCapabilities } from './worker_capabilities';
import { MeterProvider, DataPointType } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PrometheusExporter, encodeMetricScopes, combineMetricCollections } from '@kbn/metrics';
import type { ScopeMetrics } from '@kbn/metrics';
import { acquireRemoteSession } from './remote_supervisor_session';
jest.mock('./remote_supervisor_session');
import { RemoteTaskRunner } from './remote_task_runner';
import {
  TASK_PROCESS_PROTOCOL_VERSION,
  TASK_PROCESS_CAPABILITIES,
  TASK_PROCESS_PATHS,
} from './protocol';

beforeEach(() => {
  jest.mocked(acquireRemoteSession).mockImplementation(async (address) => ({
    ...address,
    featureFlags: {},
    release: jest.fn(),
  }));
});

const response = (body: object, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const health = (): Response =>
  response({
    protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
    capabilities: TASK_PROCESS_CAPABILITIES,
  });
const request = { taskType: 'test:metrics', taskInstance: {}, executionUuid: 'metrics-execution' };
let provider: MeterProvider;
let before: string;
let current: string;

beforeEach(async () => {
  const reader = PrometheusExporter.get();
  provider = new MeterProvider({ readers: [reader], resource: resourceFromAttributes({}) });
  const counter = provider.getMeter('kibana.test').createCounter('kibana.test.counter');
  counter.add(2);
  before = encodeMetricScopes((await reader.collect()).resourceMetrics.scopeMetrics);
  counter.add(3);
  current = encodeMetricScopes((await reader.collect()).resourceMetrics.scopeMetrics);
});

afterEach(async () => {
  jest.useRealTimers();
  await provider.shutdown();
  PrometheusExporter.destroy();
});

const total = (scopes: ScopeMetrics[]): number =>
  scopes
    .flatMap((scope) => scope.metrics)
    .reduce(
      (sum, metric) =>
        metric.dataPointType === DataPointType.SUM
          ? sum + metric.dataPoints.reduce((points, { value }) => points + value, 0)
          : sum,
      0
    );

it('does not count late progress again after the final native snapshot', async () => {
  jest.useFakeTimers();
  const completed = Promise.withResolvers<Response>();
  const progress = Promise.withResolvers<Response>();
  let captured: ScopeMetrics[] = [];
  const fetchFn: typeof fetch = jest.fn(async (input) => {
    const url = String(input);
    if (url.endsWith(TASK_PROCESS_PATHS.health)) return health();
    return url.endsWith(TASK_PROCESS_PATHS.run) ? completed.promise : progress.promise;
  });
  const runner = new RemoteTaskRunner({
    route: { url: 'http://worker' },
    request,
    timeoutMs: 10000,
    fetchFn,
    setCustomTaskRunEventFields: jest.fn(),
    onMetrics: (delta) => {
      captured = combineMetricCollections(captured, delta);
    },
  });
  const running = runner.run();
  await jest.advanceTimersByTimeAsync(1000);
  completed.resolve(response({ kind: 'result', prometheus: { sequence: 2, encoded: current } }));
  await running;
  progress.resolve(response({ prometheus: { sequence: 1, encoded: before } }));
  await jest.advanceTimersByTimeAsync(0);
  expect(total(captured)).toBe(5);
});

it.each(['thrown', 'declined'] as const)(
  'reports native metrics before propagating a %s execution',
  async (outcome) => {
    let captured: ScopeMetrics[] = [];
    const fetchFn: typeof fetch = async (input) => {
      if (String(input).endsWith(TASK_PROCESS_PATHS.health)) return health();
      const prometheus = { sequence: 1, encoded: before };
      return outcome === 'thrown'
        ? response({ kind: 'thrown', error: { message: 'business failure' }, prometheus })
        : response({ kind: 'declined', reason: 'unsupported capability', prometheus }, 422);
    };
    const runner = new RemoteTaskRunner({
      route: { url: 'http://worker' },
      request,
      timeoutMs: 10000,
      fetchFn,
      setCustomTaskRunEventFields: jest.fn(),
      onMetrics: (delta) => {
        captured = combineMetricCollections(captured, delta);
      },
    });
    await expect(runner.run()).rejects.toThrow();
    expect(total(captured)).toBe(2);
  }
);

it('counts the native post-cancel handoff and final native reply only once after a count-only RPC acknowledgement', async () => {
  const [mainChannel, childChannel] = sessionChannelPair();
  const child = openIpcSession(
    childChannel,
    expose(new WorkerCapabilities(() => async () => ({ createdTaskCount: 0 })))
  );
  const main = openIpcSession<WorkerCapabilities>(mainChannel);
  const completed = Promise.withResolvers<Response>();
  let captured: ScopeMetrics[] = [];
  jest.mocked(acquireRemoteSession).mockImplementation(async (address) => ({
    ...address,
    session: main,
    featureFlags: {},
    release: jest.fn(),
  }));
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith(TASK_PROCESS_PATHS.health)) return health();
    if (url.endsWith(TASK_PROCESS_PATHS.run)) return completed.promise;
    expect(url).toContain(TASK_PROCESS_PATHS.metrics);
    return response({ prometheus: { sequence: 2, encoded: current } });
  };
  const runner = new RemoteTaskRunner({
    route: { url: 'http://worker' },
    request: { ...request, cancelGracePeriodMs: 1000 },
    timeoutMs: 10000,
    fetchFn,
    setCustomTaskRunEventFields: jest.fn(),
    onMetrics: (delta) => {
      captured = combineMetricCollections(captured, delta);
    },
  });
  try {
    const running = runner.run();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.cancel();
    expect(total(captured)).toBe(5);
    completed.resolve(response({ kind: 'result', prometheus: { sequence: 2, encoded: current } }));
    await running;
    expect(total(captured)).toBe(5);
  } finally {
    main.close();
    child.close();
  }
});
