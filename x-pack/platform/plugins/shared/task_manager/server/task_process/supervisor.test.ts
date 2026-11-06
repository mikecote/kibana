/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { TaskProcessLease } from './remote_task_runner';
import { TaskProcessSupervisor } from './supervisor';
import type { TaskProcessSettings } from './supervisor';

const createBundleDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      bundles: {
        a: { file: 'a.js', taskType: 'alerting_v2:cleanup' },
        b: { file: 'b.js', taskType: 'task_manager:nodes' },
      },
    })
  );
  return dir;
};

class FakeChild extends EventEmitter {
  public send = jest.fn();
  public pid = 4242;
  public exitCode: number | null = null;
  public signalCode: string | null = null;
  public kill = jest.fn((signal?: string) => {
    this.exitCode = 0;
    this.emit('exit', 0, signal);
    return true;
  });
}

describe('TaskProcessSupervisor', () => {
  const setup = (overrides: Partial<TaskProcessSettings> = {}) => {
    const children: Array<{
      file: string;
      env: NodeJS.ProcessEnv;
      execArgv: string[];
      child: FakeChild;
    }> = [];
    const forkFn = jest.fn(
      (file: string, _args: unknown, options: { env: NodeJS.ProcessEnv; execArgv: string[] }) => {
        const child = new FakeChild();
        children.push({ file, env: options.env, execArgv: options.execArgv, child });
        return child;
      }
    );
    const supervisor = new TaskProcessSupervisor({
      settings: {
        bundle_dir: createBundleDir(),
        kibanaVersion: '9.9.9',
        ...overrides,
        getElasticsearchConfig: () => ({ hosts: ['http://es:9200'] } as never),
        getInitFor: (taskType) =>
          taskType === 'alerting_v2:cleanup'
            ? {
                server: { uuid: 'uuid', buildNum: 1, isServerless: false },
                encryptedSavedObjects: { encryptionKey: 'k'.repeat(32), decryptionOnlyKeys: [] },
              }
            : {},
      },
      logger: loggingSystemMock.createLogger(),
      forkFn: forkFn as never,
    });
    const acquire = (type: string) =>
      (supervisor.getRoute(type) as { acquire: () => Promise<TaskProcessLease> }).acquire();
    const ready = (index: number, port = 4567) =>
      children[index].child.emit('message', { kind: 'ready', port });
    return { supervisor, children, forkFn, acquire, ready };
  };

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.NODE_OPTIONS;
  });

  it('routes the task types the bundles serve and starts no process', () => {
    const { supervisor, forkFn } = setup();
    supervisor.start();
    expect(supervisor.getRoute('alerting_v2:cleanup')).toEqual({ acquire: expect.any(Function) });
    expect(supervisor.getRoute('task_manager:nodes')).toEqual({ acquire: expect.any(Function) });
    expect(supervisor.getRoute('other:type')).toBeUndefined();
    expect(forkFn).not.toHaveBeenCalled();
  });

  it('starts the bundle for a run, with the settings sent over the fork channel', async () => {
    const { supervisor, children, forkFn, acquire, ready } = setup();
    supervisor.start();
    const lease = acquire('alerting_v2:cleanup');
    expect(forkFn).toHaveBeenCalledTimes(1);
    expect(forkFn.mock.calls[0][0]).toMatch(/a\.js$/);
    expect(Object.keys(children[0].env)).not.toContain('ES_URL');
    expect(children[0].child.send).toHaveBeenCalledWith({
      kind: 'init',
      elasticsearch: { hosts: ['http://es:9200'] },
      kibanaVersion: '9.9.9',
      authToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      server: { uuid: 'uuid', buildNum: 1, isServerless: false },
      encryptedSavedObjects: { encryptionKey: 'k'.repeat(32), decryptionOnlyKeys: [] },
    });

    // What another task type declared is not sent to this one.
    const other = acquire('task_manager:nodes');
    expect(children[1].child.send.mock.calls[0][0]).not.toHaveProperty('encryptedSavedObjects');
    ready(1);
    await other;

    ready(0);
    const { url, token } = await lease;
    expect(url).toBe('http://127.0.0.1:4567');
    expect(token).toBe(
      (children[0].child.send.mock.calls[0][0] as { authToken: string }).authToken
    );
  });

  it('reads what Kibana has now before it starts the process, and starts none when that fails', async () => {
    const getInitFor = jest
      .fn()
      .mockResolvedValueOnce({ parity: [{ kind: 'connectorTypes', ids: ['.email'] }] })
      .mockRejectedValueOnce(new Error('cannot read the overrides'));
    const forkFn = jest.fn(() => new FakeChild());
    const supervisor = new TaskProcessSupervisor({
      settings: {
        bundle_dir: createBundleDir(),
        kibanaVersion: '9.9.9',
        getElasticsearchConfig: () => ({ hosts: ['http://es:9200'] } as never),
        getInitFor,
      },
      logger: loggingSystemMock.createLogger(),
      forkFn: forkFn as never,
    });
    supervisor.start();
    const route = supervisor.getRoute('alerting_v2:cleanup') as {
      acquire: () => Promise<TaskProcessLease>;
    };

    const first = route.acquire();
    await new Promise((resolve) => setImmediate(resolve));
    const child = forkFn.mock.results[0].value as FakeChild;
    expect(child.send).toHaveBeenCalledWith(
      expect.objectContaining({ parity: [{ kind: 'connectorTypes', ids: ['.email'] }] })
    );
    child.emit('message', { kind: 'ready', port: 1 });
    await first;

    await expect(route.acquire()).rejects.toThrow('cannot read the overrides');
    expect(forkFn).toHaveBeenCalledTimes(1);
  });

  it('gives each run a process of its own and stops it when the run ends', async () => {
    const { supervisor, children, forkFn, acquire, ready } = setup();
    supervisor.start();
    const first = acquire('alerting_v2:cleanup');
    const second = acquire('alerting_v2:cleanup');
    ready(0, 4001);
    ready(1, 4002);
    const [a, b] = await Promise.all([first, second]);
    expect(forkFn).toHaveBeenCalledTimes(2);
    expect([a.url, b.url]).toEqual(['http://127.0.0.1:4001', 'http://127.0.0.1:4002']);

    a.release();
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[1].child.kill).not.toHaveBeenCalled();
  });

  it('rejects a run, and stops the process, when it exits before it is ready', async () => {
    const { supervisor, children, acquire } = setup();
    supervisor.start();
    const failed = acquire('alerting_v2:cleanup');
    children[0].child.emit('exit', 1, null);
    await expect(failed).rejects.toThrow(/before it was ready/);
  });

  it('kills a process that does not become ready', async () => {
    jest.useFakeTimers();
    const { supervisor, children, acquire } = setup();
    supervisor.start();
    const failed = acquire('alerting_v2:cleanup');
    jest.advanceTimersByTime(30_000);
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(failed).rejects.toThrow(/ready/);
  });

  it('stops routing and terminates the running processes on stop', async () => {
    const { supervisor, children, acquire, ready } = setup({ drainTimeoutMs: 10 });
    supervisor.start();
    const pending = acquire('alerting_v2:cleanup');
    ready(0);
    await pending;
    await supervisor.stop();
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.getRoute('alerting_v2:cleanup')).toBeUndefined();
  });

  it('declines a run past max_concurrent_processes with the capacity reason, and takes it again when one is released', async () => {
    const { supervisor, children, acquire, ready } = setup({ maxConcurrentProcesses: 2 });
    supervisor.start();
    const first = acquire('alerting_v2:cleanup');
    const second = acquire('alerting_v2:cleanup');
    // Held before they are ready, so runs that start together cannot pass the cap.
    await expect(acquire('alerting_v2:cleanup')).rejects.toMatchObject({ reason: 'capacity' });
    ready(0);
    ready(1);
    const [a] = await Promise.all([first, second]);
    expect(supervisor.getStats()).toMatchObject({
      live: 2,
      active: 2,
      max: 2,
      spawned: 2,
      capacityRejections: 1,
    });

    a.release();
    const third = acquire('alerting_v2:cleanup');
    ready(2);
    await third;
    expect(children).toHaveLength(3);
    expect(supervisor.getStats().active).toBe(2);
  });

  it('frees its place when a process cannot be started, and reports why', async () => {
    jest.useFakeTimers();
    const { supervisor, children, acquire } = setup({ maxConcurrentProcesses: 1 });
    supervisor.start();
    const exited = acquire('alerting_v2:cleanup');
    children[0].child.emit('exit', 1, null);
    await expect(exited).rejects.toMatchObject({ reason: 'spawn_failed' });

    const timedOut = acquire('alerting_v2:cleanup');
    jest.advanceTimersByTime(30_000);
    await expect(timedOut).rejects.toMatchObject({ reason: 'spawn_timeout' });
    expect(supervisor.getStats()).toMatchObject({
      active: 0,
      spawnFailures: 1,
      spawnTimeouts: 1,
    });
  });

  it('reports a process that cannot be spawned instead of crashing on its error event', async () => {
    const { supervisor, children, acquire } = setup();
    supervisor.start();
    const failed = acquire('alerting_v2:cleanup');
    children[0].child.emit('error', new Error('spawn ENOENT'));
    await expect(failed).rejects.toMatchObject({ reason: 'spawn_failed' });
    // And a later error event has a listener.
    expect(() => children[0].child.emit('error', new Error('again'))).not.toThrow();
  });

  it('starts a process without the inspector and heap flags of Kibana, and with the configured heap', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=8192 --enable-source-maps';
    const argv = jest.replaceProperty(process, 'execArgv', ['--inspect=9229', '--no-warnings']);
    try {
      const { supervisor, children, acquire } = setup({ childMaxOldSpaceMb: 256 });
      supervisor.start();
      acquire('alerting_v2:cleanup').catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
      expect(children[0].execArgv).toEqual([
        '--no-warnings',
        '--max-old-space-size=256',
        '--max-semi-space-size=2',
      ]);
      expect(children[0].env.NODE_OPTIONS).toBe('--enable-source-maps');
      expect(children[0].env.TASK_PROCESS_LOG_LAYOUT).toBe('json');
      expect(children[0].env.TASK_PROCESS_LOG_LEVEL).toBeDefined();
    } finally {
      argv.restore();
    }
  });

  it('does not pass NODE_OPTIONS on when only heap flags were in it', async () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=8192';
    const { supervisor, children, acquire } = setup();
    supervisor.start();
    acquire('alerting_v2:cleanup').catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(children[0].env).not.toHaveProperty('NODE_OPTIONS');
  });

  it('on stop rejects new runs, lets a run in flight finish, and kills nothing that finishes in time', async () => {
    jest.useFakeTimers();
    const { supervisor, children, ready } = setup({ drainTimeoutMs: 10_000 });
    supervisor.start();
    const route = supervisor.getRoute('alerting_v2:cleanup') as {
      acquire: () => Promise<TaskProcessLease>;
    };
    const pending = route.acquire();
    ready(0);
    const lease = await pending;
    const stopped = supervisor.stop();
    await expect(route.acquire()).rejects.toMatchObject({ reason: 'unavailable' });
    jest.advanceTimersByTime(5000);
    expect(children[0].child.kill).not.toHaveBeenCalled();
    lease.release();
    await stopped;
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(children[0].child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('on stop kills the processes that outlive the drain bound', async () => {
    jest.useFakeTimers();
    const { supervisor, children, acquire, ready } = setup({ drainTimeoutMs: 10_000 });
    supervisor.start();
    const pending = acquire('alerting_v2:cleanup');
    ready(0);
    await pending;
    // A process that ignores SIGTERM.
    children[0].child.kill.mockImplementation((signal?: string) => {
      if (signal === 'SIGKILL') {
        children[0].child.exitCode = 0;
        children[0].child.emit('exit', null, signal);
      }
      return true;
    });
    const stopped = supervisor.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    await jest.advanceTimersByTimeAsync(2_000);
    await stopped;
    expect(children[0].child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('throws a clear error when the bundle directory has no manifest', () => {
    const supervisor = new TaskProcessSupervisor({
      settings: {
        bundle_dir: join(tmpdir(), 'does-not-exist'),
        kibanaVersion: '9.9.9',
        getElasticsearchConfig: () => ({ hosts: ['http://es:9200'] } as never),
      },
      logger: loggingSystemMock.createLogger(),
    });
    expect(() => supervisor.start()).toThrow(/No task bundle manifest/);
  });
});
