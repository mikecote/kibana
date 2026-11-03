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
import { createPodDispatch } from './pod_dispatch';
import { TaskProcessSupervisor } from './supervisor';

const createBundleDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-bundles-'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      bundles: {
        a: { file: 'a.js', taskTypes: ['alerting_v2:cleanup'] },
        b: { file: 'b.js', taskTypes: ['task_manager:nodes'] },
      },
    })
  );
  return dir;
};

class FakeChild extends EventEmitter {
  public stdout = new EventEmitter();
  public pid = 4242;
  public exitCode: number | null = null;
  public kill = jest.fn((signal?: string) => {
    this.exitCode = 0;
    this.emit('exit', 0, signal);
    return true;
  });
}

describe('TaskProcessSupervisor', () => {
  const setup = (taskTypes: string[]) => {
    const children: Array<{ file: string; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
    const dispatch = createPodDispatch({ kibanaVersion: '9.9.9' });
    const forkFn = jest.fn((file: string, _args: unknown, options: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild();
      children.push({ file, env: options.env, child });
      return child;
    });
    const supervisor = new TaskProcessSupervisor({
      settings: {
        task_types: taskTypes,
        bundle_dir: createBundleDir(),
        elasticsearch: { url: 'http://es:9200', api_key: 'key' },
      },
      dispatch,
      logger: loggingSystemMock.createLogger(),
      forkFn: forkFn as never,
    });
    return { supervisor, dispatch, children, forkFn };
  };

  it('starts only the bundles that serve a configured task type', () => {
    const { supervisor, forkFn } = setup(['alerting_v2:*']);
    supervisor.start();
    expect(forkFn).toHaveBeenCalledTimes(1);
    expect(forkFn.mock.calls[0][0]).toMatch(/a\.js$/);
  });

  it('passes credentials in the environment and a secret for the run endpoints', () => {
    const { supervisor, children } = setup(['alerting_v2:*']);
    supervisor.start();
    expect(children[0].env).toEqual(
      expect.objectContaining({
        ES_URL: 'http://es:9200',
        ES_API_KEY: 'key',
        PORT: '0',
        POD_KIBANA_VERSION: '9.9.9',
        POD_AUTH_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
  });

  it('routes the task types to the process once it reports its port, and not before', () => {
    const { supervisor, dispatch, children } = setup(['alerting_v2:*']);
    supervisor.start();
    expect(dispatch.getPod('alerting_v2:cleanup')).toBeUndefined();

    children[0].child.stdout.emit('data', Buffer.from('READY 4567\n'));
    expect(dispatch.getPod('alerting_v2:cleanup')).toEqual({
      url: 'http://127.0.0.1:4567',
      token: children[0].env.POD_AUTH_TOKEN,
    });
    expect(dispatch.getPod('task_manager:nodes')).toBeUndefined();
  });

  it('stops routing to a process that exits, and starts it again', () => {
    jest.useFakeTimers();
    try {
      const { supervisor, dispatch, children, forkFn } = setup(['alerting_v2:*']);
      supervisor.start();
      children[0].child.stdout.emit('data', Buffer.from('READY 4567\n'));
      children[0].child.emit('exit', 1, null);

      expect(dispatch.getPod('alerting_v2:cleanup')).toBeUndefined();
      jest.advanceTimersByTime(1000);
      expect(forkFn).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('terminates the processes on stop and does not restart them', async () => {
    jest.useFakeTimers();
    try {
      const { supervisor, children, forkFn } = setup(['alerting_v2:*']);
      supervisor.start();
      await supervisor.stop();
      expect(children[0].child.kill).toHaveBeenCalledWith('SIGTERM');
      jest.advanceTimersByTime(60_000);
      expect(forkFn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('throws a clear error when the bundle directory has no manifest', () => {
    const dispatch = createPodDispatch({ kibanaVersion: '9.9.9' });
    const supervisor = new TaskProcessSupervisor({
      settings: {
        task_types: ['a:*'],
        bundle_dir: join(tmpdir(), 'does-not-exist'),
        elasticsearch: { url: 'http://es:9200' },
      },
      dispatch,
      logger: loggingSystemMock.createLogger(),
    });
    expect(() => supervisor.start()).toThrow(/No task bundle manifest/);
  });
});
