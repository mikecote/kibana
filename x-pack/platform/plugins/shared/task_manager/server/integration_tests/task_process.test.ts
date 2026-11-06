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

import { execSync, spawn } from 'child_process';
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
import type { TaskProcessSettings } from '../task_process/supervisor';
import { backgroundTaskNodeMapping, taskMappings } from '../saved_objects/mappings';
import {
  BACKGROUND_TASK_NODE_SO_NAME,
  backgroundTaskNodeType,
} from '../saved_objects/background_task_node_type';
import type { TaskProcessInit } from '../task_process/wire';
import {
  GLOBAL_UI_SETTING,
  PLUMBING_PARITY_KIND,
  PLUMBING_TASK_TYPE,
  UI_SETTING,
} from './fixtures/settings_plumbing.task';
import { retry } from './lib';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getTaskBundleEntries, buildTaskBundle } = require(join(
  REPO_ROOT,
  'src/dev/task_bundles/build'
));

const MARK_REMOVED = 'task_manager:mark_removed_tasks_as_unrecognized';
const DELETE_NODES = 'task_manager:delete_inactive_background_task_nodes';
const INDEX = backgroundTaskNodeType.indexPattern!;
const DELETE_BUNDLE = 'taskManager__delete_inactive_nodes.mjs';
// Core, which a task process runs, refuses an Elasticsearch older than itself.
const KIBANA_VERSION = kibanaPackageJson.version;

/**
 * Builds the bundles of Task Manager's own task types and runs them the way Kibana does: forked
 * by the supervisor with the Elasticsearch connection sent over the fork channel, reached by
 * `RemoteTaskRunner`. The task code runs in the child process against a real cluster. (Booting all
 * of Kibana is not needed to prove this; plugin wiring is covered by unit tests.)
 */
describe('task types served from bundles', () => {
  let esServer: TestElasticsearchUtils;
  let es: Client;
  let supervisor: TaskProcessSupervisor;
  let bundleDir: string;
  const esConfig = () =>
    elasticsearchConfigFromEnv({
      ES_URL: esServer.hosts[0],
      ES_USERNAME: esServer.username,
      ES_PASSWORD: esServer.password,
    });

  const run = async (taskType: string, id: string) => {
    const pod = supervisor.getRoute(taskType)!;
    expect(pod).toBeDefined();
    return new RemoteTaskRunner({
      route: pod,
      request: {
        taskType,
        taskInstance: { id, taskType, params: {}, state: {} },
        executionUuid: `${id}-${Date.now()}`,
        kibanaVersion: KIBANA_VERSION,
      },
      timeoutMs: 30000,
      setCustomTaskRunEventFields: jest.fn(),
      fetchFn: undiciFetch as unknown as typeof fetch,
    }).run();
  };

  beforeAll(async () => {
    const { startES } = createTestServers({
      adjustTimeout: (t) => jest.setTimeout(t),
      settings: { es: { license: 'trial' } },
    });
    esServer = await startES();
    es = esServer.es.getClient();

    // The index and aliases Kibana's migrator would have created: the saved objects repository
    // addresses the alias of its own version, which the process takes from Kibana.
    await es.indices.create({
      index: `${INDEX}_${KIBANA_VERSION}_001`,
      aliases: { [INDEX]: {}, [`${INDEX}_${KIBANA_VERSION}`]: {} },
      mappings: {
        dynamic: false,
        properties: {
          type: { type: 'keyword' },
          updated_at: { type: 'date' },
          task: taskMappings,
          [BACKGROUND_TASK_NODE_SO_NAME]: backgroundTaskNodeMapping,
        },
      },
    });

    bundleDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
    const entries = getTaskBundleEntries().filter(
      ({ pluginId }: { pluginId: string }) => pluginId === 'taskManager'
    );
    const built = await Promise.all(
      entries.map((entry: unknown) => buildTaskBundle({ entry, outDir: bundleDir }))
    );
    const typeByBundle = new Map([
      ['taskManager__delete_inactive_nodes', DELETE_NODES],
      ['taskManager__mark_removed_tasks_as_unrecognized', MARK_REMOVED],
    ]);
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify({
        bundles: Object.fromEntries(
          built.map(({ name }: { name: string }) => [
            name,
            { file: `${name}.mjs`, taskType: typeByBundle.get(name) },
          ])
        ),
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
      },
      logger: loggingSystemMock.createLogger(),
    });
    supervisor.start();
  });

  afterAll(async () => {
    await supervisor?.stop();
    await esServer?.stop();
  });

  it('marks removed tasks as unrecognized from a task process', async () => {
    await es.index({
      index: INDEX,
      id: 'task:removed-1',
      refresh: 'wait_for',
      document: {
        type: 'task',
        updated_at: new Date().toISOString(),
        task: {
          taskType: 'sampleTaskRemovedType',
          status: 'idle',
          runAt: new Date().toISOString(),
        },
      },
    });

    await expect(run(MARK_REMOVED, 'mark_removed_tasks_as_unrecognized')).resolves.toEqual({
      state: {},
      schedule: { interval: '1h' },
    });

    const doc = await es.get<{ task: { status: string } }>({ index: INDEX, id: 'task:removed-1' });
    expect(doc._source?.task.status).toBe('unrecognized');
  });

  it('starts a process for each run and stops it when the run ends', async () => {
    const children = () =>
      execSync(`pgrep -f "${DELETE_BUNDLE}" || true`, { encoding: 'utf8' }).trim();
    expect(children()).toBe('');
    await run(DELETE_NODES, 'delete_inactive_background_task_nodes');
    await retry(async () => expect(children()).toBe(''));
    await expect(run(DELETE_NODES, 'delete_inactive_background_task_nodes')).resolves.toBeDefined();
  });

  it('deletes inactive nodes through saved objects from a task process', async () => {
    const node = (id: string, lastSeen: Date) =>
      es.index({
        index: INDEX,
        id: `${BACKGROUND_TASK_NODE_SO_NAME}:${id}`,
        refresh: 'wait_for',
        document: {
          type: BACKGROUND_TASK_NODE_SO_NAME,
          updated_at: new Date().toISOString(),
          [BACKGROUND_TASK_NODE_SO_NAME]: { id, last_seen: lastSeen.toISOString() },
        },
      });
    await node('inactive', new Date(Date.now() - 60 * 60 * 1000));
    await node('active', new Date());

    await expect(run(DELETE_NODES, 'delete_inactive_background_task_nodes')).resolves.toEqual({
      state: {},
      schedule: { interval: '1m' },
    });

    await expect(
      es.exists({ index: INDEX, id: `${BACKGROUND_TASK_NODE_SO_NAME}:inactive` })
    ).resolves.toBe(false);
    await expect(
      es.exists({ index: INDEX, id: `${BACKGROUND_TASK_NODE_SO_NAME}:active` })
    ).resolves.toBe(true);
  });

  describe('what Kibana sends a process besides the run', () => {
    type Init = Partial<
      Omit<TaskProcessInit, 'kind' | 'authToken' | 'elasticsearch' | 'kibanaVersion'>
    >;
    let plumbing: TaskProcessSupervisor;
    // What Kibana would send for the next run: it reads it for each one.
    let init: Init = {};
    const server = {
      uuid: '5b2de169-2785-441b-ae8c-186a1936b17d',
      buildNum: 1,
      isServerless: false,
    };

    beforeAll(async () => {
      // The config saved objects the ui settings client reads; Kibana's migrator creates them.
      await es.indices.create({
        index: `.kibana_${KIBANA_VERSION}_001`,
        aliases: { '.kibana': {}, [`.kibana_${KIBANA_VERSION}`]: {} },
        mappings: { dynamic: false, properties: { type: { type: 'keyword' } } },
      });
      const plumbingDir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
      const built = await buildTaskBundle({
        entry: {
          pluginId: 'taskManager',
          name: 'taskManager__settings_plumbing',
          file: join(__dirname, 'fixtures/settings_plumbing.task.ts'),
        },
        outDir: plumbingDir,
      });
      writeFileSync(
        join(plumbingDir, 'manifest.json'),
        JSON.stringify({
          bundles: { [built.name]: { file: `${built.name}.mjs`, taskType: PLUMBING_TASK_TYPE } },
        })
      );
      plumbing = new TaskProcessSupervisor({
        settings: {
          bundle_dir: plumbingDir,
          kibanaVersion: KIBANA_VERSION,
          getElasticsearchConfig: () =>
            elasticsearchConfigFromEnv({
              ES_URL: esServer.hosts[0],
              ES_USERNAME: esServer.username,
              ES_PASSWORD: esServer.password,
            }),
          getInitFor: async () => init,
        },
        logger: loggingSystemMock.createLogger(),
      });
      plumbing.start();
    });

    afterAll(async () => {
      await plumbing?.stop();
    });

    const runPlumbing = async () => {
      const route = plumbing.getRoute(PLUMBING_TASK_TYPE) as {
        acquire: () => Promise<TaskProcessLease>;
      };
      const lease = await route.acquire();
      try {
        const response = await undiciFetch(`${lease.url}/run`, {
          method: 'POST',
          headers: { authorization: `Bearer ${lease.token}` },
          body: JSON.stringify({
            taskType: PLUMBING_TASK_TYPE,
            taskInstance: { id: 'plumbing', taskType: PLUMBING_TASK_TYPE, params: {}, state: {} },
            executionUuid: `plumbing-${Date.now()}`,
            kibanaVersion: KIBANA_VERSION,
          }),
        });
        return {
          status: response.status,
          body: (await response.json()) as { result: { state: Record<string, unknown> } } & Record<
            string,
            unknown
          >,
        };
      } finally {
        lease.release();
      }
    };

    it('registers the defaults of a ui setting and a global ui setting for the module', async () => {
      init = { server };
      const { status, body } = await runPlumbing();
      expect(status).toBe(200);
      expect(body.result.state).toEqual({
        setting: 'default',
        globalSetting: 'global default',
        // Kibana has no public base URL, so the process has none: links are empty exactly as in Kibana.
        publicBaseUrl: null,
      });
    });

    it('gives the module the ui settings overrides and global overrides of Kibana', async () => {
      init = {
        server,
        uiSettingsOverrides: { [UI_SETTING]: 'overridden' },
        uiSettingsGlobalOverrides: { [GLOBAL_UI_SETTING]: 'globally overridden' },
      };
      const { status, body } = await runPlumbing();
      expect(status).toBe(200);
      expect(body.result.state).toEqual(
        expect.objectContaining({ setting: 'overridden', globalSetting: 'globally overridden' })
      );
    });

    it('has the public base URL Kibana has, as it has it', async () => {
      init = {
        // A path in the public base URL needs Kibana's base path, which Core validates it against.
        server: { ...server, publicBaseUrl: 'https://kibana.example.com/kbn', basePath: '/kbn' },
      };
      const { body } = await runPlumbing();
      expect(body.result.state.publicBaseUrl).toBe('https://kibana.example.com/kbn');
    });

    it('runs when the process registered everything Kibana did', async () => {
      init = { server, parity: [{ kind: PLUMBING_PARITY_KIND, ids: ['a'] }] };
      expect((await runPlumbing()).status).toBe(200);
    });

    it('declines the run, naming what is missing, when Kibana has registered more', async () => {
      init = { server, parity: [{ kind: PLUMBING_PARITY_KIND, ids: ['a', 'registered-later'] }] };
      const { status, body } = await runPlumbing();
      expect(status).toBe(422);
      expect(body).toEqual({
        kind: 'declined',
        reason: expect.stringContaining(`${PLUMBING_PARITY_KIND} [registered-later]`),
      });
    });
  });

  describe('a process of production hardening', () => {
    const bundleFile = () => join(bundleDir, DELETE_BUNDLE);
    const childPids = () =>
      execSync(`pgrep -f "${DELETE_BUNDLE}" || true`, { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map(Number);
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const createSupervisor = (settings: Partial<TaskProcessSettings>) => {
      const hardened = new TaskProcessSupervisor({
        settings: {
          bundle_dir: bundleDir,
          kibanaVersion: KIBANA_VERSION,
          getElasticsearchConfig: esConfig,
          drainTimeoutMs: 1000,
          ...settings,
        },
        logger: loggingSystemMock.createLogger(),
      });
      hardened.start();
      return hardened;
    };
    const routeOf = (hardened: TaskProcessSupervisor) =>
      hardened.getRoute(DELETE_NODES) as {
        acquire: (context?: { executionUuid?: string }) => Promise<TaskProcessLease>;
      };

    it('ends a process whose parent was killed', async () => {
      // A parent of our own that forks the bundle the way the supervisor does, then is SIGKILLed.
      const harnessDir = mkdtempSync(join(tmpdir(), 'task-harness-'));
      const initFile = join(harnessDir, 'init.json');
      writeFileSync(
        initFile,
        JSON.stringify({
          kind: 'init',
          elasticsearch: esConfig(),
          kibanaVersion: KIBANA_VERSION,
          authToken: 'token',
        }),
        { mode: 0o600 }
      );
      const harnessFile = join(harnessDir, 'harness.js');
      writeFileSync(
        harnessFile,
        `
        const { fork } = require('child_process');
        const child = fork(process.argv[2], [], {
          env: { ...process.env, PORT: '0' },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.on('message', (m) => {
          if (m && m.kind === 'ready') console.log('CHILD ' + child.pid);
        });
        child.send(JSON.parse(require('fs').readFileSync(process.argv[3], 'utf8')));
        setInterval(() => {}, 1000);
      `
      );
      const harness = spawn(process.execPath, [harnessFile, bundleFile(), initFile], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      try {
        const childPid = await new Promise<number>((resolve, reject) => {
          harness.once('exit', () => reject(new Error('the harness exited early')));
          harness.stdout!.on('data', (chunk: Buffer) => {
            const match = /CHILD (\d+)/.exec(chunk.toString());
            if (match) resolve(Number(match[1]));
          });
        });
        expect(isAlive(childPid)).toBe(true);

        // Only the parent this test started.
        harness.kill('SIGKILL');
        await retry(async () => expect(isAlive(childPid)).toBe(false), {
          times: 30,
          intervalMs: 500,
        });
      } finally {
        harness.kill('SIGKILL');
      }
    });

    it('runs in Kibana, counted as capacity, when max_concurrent_processes processes are held', async () => {
      const capped = createSupervisor({ maxConcurrentProcesses: 1 });
      const held = await routeOf(capped).acquire();
      const local = { run: jest.fn().mockResolvedValue({ state: { local: true } }) };
      const onFallback = jest.fn();
      try {
        await expect(
          new RemoteTaskRunner({
            route: routeOf(capped),
            request: {
              taskType: DELETE_NODES,
              taskInstance: { id: 'capped', taskType: DELETE_NODES, params: {}, state: {} },
              executionUuid: 'capped-1',
              kibanaVersion: KIBANA_VERSION,
            },
            timeoutMs: 30000,
            setCustomTaskRunEventFields: jest.fn(),
            fallback: () => local,
            onFallback,
            fetchFn: undiciFetch as unknown as typeof fetch,
          }).run()
        ).resolves.toEqual({ state: { local: true } });
        expect(onFallback).toHaveBeenCalledWith(DELETE_NODES, 'capacity', expect.any(String));
        expect(capped.getStats()).toMatchObject({ live: 1, active: 1, capacityRejections: 1 });
      } finally {
        held.release();
        await capped.stop();
      }
    });

    it('starts a process without the inspector and heap flags of Kibana and with the configured heap', async () => {
      const previous = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = '--max-old-space-size=123 --inspect-port=0 --no-warnings';
      const configured = createSupervisor({ childMaxOldSpaceMb: 321 });
      let lease: TaskProcessLease | undefined;
      try {
        lease = await routeOf(configured).acquire();
        const [pid] = childPids();
        expect(pid).toBeDefined();
        // `e` prints the environment after the command line.
        const command = execSync(`ps eww -o command= -p ${pid}`, { encoding: 'utf8' });
        expect(command).toContain('--max-old-space-size=321');
        expect(command).not.toContain('--max-old-space-size=123');
        // The young generation of a process is small, whatever Kibana's own is.
        expect(command).toContain('--max-semi-space-size=2');
        expect(command).not.toContain('--inspect');
        expect(command).toContain('NODE_OPTIONS=--no-warnings');
      } finally {
        lease?.release();
        await configured.stop();
        if (previous === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previous;
      }
    });

    it('listens on the loopback address only', async () => {
      const loopback = createSupervisor({});
      const lease = await routeOf(loopback).acquire();
      try {
        const port = new URL(lease.url).port;
        const listening = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN || true`, {
          encoding: 'utf8',
        });
        expect(listening).toContain(`127.0.0.1:${port}`);
        expect(listening).not.toContain(`*:${port}`);
      } finally {
        lease.release();
        await loopback.stop();
      }
    });
  });
});
