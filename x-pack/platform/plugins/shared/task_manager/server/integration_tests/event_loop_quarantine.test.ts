/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidV4 } from 'uuid';
import { performance } from 'node:perf_hooks';
import { runInThisContext } from 'node:vm';
import {
  createTestServers,
  type TestElasticsearchUtils,
  type TestKibanaUtils,
} from '@kbn/core-test-helpers-kbn-server';
import type { TaskClaimingOpts } from '../queries/task_claiming';
import { TaskStatus } from '../task';
import { CURRENT_TASK_ACCESSOR } from '../event_loop_watchdog/types';
import { TASK_MANAGER_INDEX } from '../constants';
import { TaskManagerPlugin, type TaskManagerStartContract } from '../plugin';
import { retry } from './lib';
import { setupKibanaServer } from './lib/setup_test_servers';

// A task is considered the culprit once it has blocked the loop for at least this long.
const FLAG_THRESHOLD_MS = 1000;
// Long enough to clear the flag threshold with margin for a few landed samples.
const SPIN_MS = 2500;
const POLL_INTERVAL_MS = 500;

const TASK_TYPE = '_eventLoopQuarantineTestType';

const spin = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // intentionally block the event loop, as a real culprit task would
  }
};

let shouldSpin = true;
const mockTaskTypeRunFn = jest.fn(async () => {
  if (shouldSpin) spin(SPIN_MS);
  return { state: {} };
});
const mockCreateTaskRunner = jest.fn(() => ({ run: mockTaskTypeRunFn }));
const mockTaskType = {
  title: 'Event loop quarantine test task (PoC)',
  createTaskRunner: mockCreateTaskRunner,
};

jest.mock('../queries/task_claiming', () => {
  const actual = jest.requireActual('../queries/task_claiming');
  return {
    ...actual,
    TaskClaiming: jest.fn().mockImplementation((opts: TaskClaimingOpts) => {
      // Definitions added after instantiation aren't claimed ("partitionIntoClaimingBatches").
      opts.definitions.registerTaskDefinitions({ [TASK_TYPE]: mockTaskType });
      return new actual.TaskClaiming(opts);
    }),
  };
});

const taskManagerStartSpy = jest.spyOn(TaskManagerPlugin.prototype, 'start');

function latestStartContract(): TaskManagerStartContract {
  const lastResult = taskManagerStartSpy.mock.results[taskManagerStartSpy.mock.results.length - 1];
  return lastResult.value as TaskManagerStartContract;
}

// The worker's inspector session evaluates against the real process global, but Kibana's modules
// (including the accessor `watchdog.ts` installs) run inside Jest's own vm context. Mirror the
// accessor once it's installed, exactly as the standalone watchdog integration test does.
const realGlobal = runInThisContext('globalThis') as Record<symbol, unknown>;
async function mirrorCurrentTaskAccessorOnceInstalled(): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(globalThis as Record<symbol, unknown>)[CURRENT_TASK_ACCESSOR]) {
    if (Date.now() > deadline) throw new Error('Event loop watchdog never installed its accessor');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  realGlobal[CURRENT_TASK_ACCESSOR] = (globalThis as Record<symbol, unknown>)[
    CURRENT_TASK_ACCESSOR
  ];
}

async function getTaskDoc(
  esClient: TestKibanaUtils['coreStart']['elasticsearch']['client']['asInternalUser'],
  id: string
) {
  const result = await esClient.get<{
    task: { status: TaskStatus; quarantine?: { persistedBy: string; blockedMs: number } };
  }>({ index: TASK_MANAGER_INDEX, id: `task:${id}` });
  return result._source!.task;
}

async function cleanupTask(taskManagerPlugin: TaskManagerStartContract, id: string) {
  try {
    await taskManagerPlugin.removeIfExists(id);
  } catch (e) {
    // best-effort cleanup only
  }
}

describe('event loop quarantine (real worker, real inspector, real Elasticsearch) (PoC)', () => {
  let esServer: TestElasticsearchUtils;
  let kibanaServer: TestKibanaUtils;

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (timeout) => jest.setTimeout(timeout),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();

    ({ kibanaServer } = await setupKibanaServer({
      server: { uuid: uuidV4() },
      node: { roles: ['background_tasks'] },
      xpack: {
        task_manager: {
          claim_strategy: 'mget',
          poll_interval: POLL_INTERVAL_MS,
          unsafe: { exclude_task_types: ['[A-Za-z]*'] },
          event_loop_watchdog: {
            enabled: true,
            flag_threshold_ms: FLAG_THRESHOLD_MS,
            min_cpu_ratio: 0.5,
            live_report_interval_ms: 500,
            quarantine_blocking_tasks: true,
          },
        },
      },
    }));

    await mirrorCurrentTaskAccessorOnceInstalled();
  });

  afterAll(async () => {
    if (kibanaServer) await kibanaServer.stop();
    if (esServer) await esServer.stop();
  });

  it('quarantines the task that blocked the event loop, directly from the worker, and runSoon releases it', async () => {
    const taskManagerPlugin = latestStartContract();
    const esClient = kibanaServer.coreStart.elasticsearch.client.asInternalUser;
    const id = uuidV4();
    shouldSpin = true;

    try {
      await taskManagerPlugin.schedule({
        id,
        taskType: TASK_TYPE,
        params: {},
        state: {},
      });

      // The worker persists the quarantine itself, directly to Elasticsearch, independent of
      // (and before) the main thread's own completion write.
      await retry(
        async () => {
          const task = await getTaskDoc(esClient, id);
          expect(task.status).toBe(TaskStatus.Quarantined);
          expect(task.quarantine?.persistedBy).toBe('worker');
        },
        { times: 60, intervalMs: 500 }
      );
      expect(mockTaskTypeRunFn).toHaveBeenCalledTimes(1);

      // Quarantined: not reclaimed by regular polling even after several more poll cycles.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS * 6));
      expect(mockTaskTypeRunFn).toHaveBeenCalledTimes(1);
      expect((await getTaskDoc(esClient, id)).status).toBe(TaskStatus.Quarantined);

      // Released via runSoon: claimed again, and this run doesn't block, so it completes.
      shouldSpin = false;
      await taskManagerPlugin.runSoon(id, { requestImmediateClaim: true });

      await retry(async () => {
        expect(mockTaskTypeRunFn).toHaveBeenCalledTimes(2);
      });
      await retry(async () => {
        const task = await getTaskDoc(esClient, id);
        expect(task.status).not.toBe(TaskStatus.Quarantined);
      });
    } finally {
      await cleanupTask(taskManagerPlugin, id);
    }
  }, 120_000);
});
