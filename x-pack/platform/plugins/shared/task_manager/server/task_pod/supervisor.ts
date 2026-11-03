/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { fork } from 'child_process';
import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Logger } from '@kbn/core/server';
import type { PodDispatch } from './pod_dispatch';

/** `manifest.json` of a task bundle directory: which task types each bundle serves. */
export interface TaskBundleManifest {
  bundles: Record<string, { file: string; taskTypes: string[] }>;
}

export interface TaskProcessSettings {
  task_types: string[];
  bundle_dir: string;
  config_file?: string;
  elasticsearch: { url: string; username?: string; password?: string; api_key?: string };
  max_concurrency?: number;
}

const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const READY_TIMEOUT_MS = 60_000;
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * Starts the task bundles that serve the configured task types as child processes of Kibana and
 * routes those task types to them. The same bundles run as external pods; only who starts them
 * differs. A process that exits is restarted with backoff, and while it is down its task types run
 * in this process, so a crashed process never strands a task.
 */
export class TaskProcessSupervisor {
  private readonly token = randomBytes(32).toString('hex');
  private readonly children = new Map<string, ChildProcess>();
  private readonly removeRoutes = new Map<string, () => void>();
  private readonly restarts = new Map<string, number>();
  private stopping = false;

  constructor(
    private readonly params: {
      settings: TaskProcessSettings;
      dispatch: PodDispatch;
      logger: Logger;
      /** Defaults to Node's `child_process.fork`; tests inject a fake. */
      forkFn?: typeof fork;
    }
  ) {}

  /** The bundles whose task types match the configured globs. */
  public selectBundles(): Array<{ name: string; file: string; taskTypes: string[] }> {
    const { settings } = this.params;
    const manifestPath = join(settings.bundle_dir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(
        `No task bundle manifest at ${manifestPath}; build the bundles (node scripts/task_bundle) or set xpack.task_manager.task_processes.bundle_dir`
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TaskBundleManifest;
    const patterns = settings.task_types.map(globToRegExp);
    return Object.entries(manifest.bundles)
      .map(([name, { file, taskTypes }]) => ({
        name,
        file: join(settings.bundle_dir, file),
        taskTypes: taskTypes.filter((type) => patterns.some((p) => p.test(type))),
      }))
      .filter(({ taskTypes }) => taskTypes.length > 0);
  }

  public start() {
    const bundles = this.selectBundles();
    if (!bundles.length) {
      this.params.logger.warn(
        `No task bundle serves ${this.params.settings.task_types.join(
          ', '
        )}; they keep running in Kibana`
      );
    }
    bundles.forEach((bundle) => this.spawn(bundle));
  }

  public async stop() {
    this.stopping = true;
    this.removeRoutes.forEach((remove) => remove());
    this.removeRoutes.clear();
    await Promise.all(
      [...this.children.values()].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) return resolve();
            const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            // The process drains in-flight runs on SIGTERM before it exits.
            child.kill('SIGTERM');
          })
      )
    );
    this.children.clear();
  }

  private spawn(bundle: { name: string; file: string; taskTypes: string[] }) {
    const { settings, dispatch, logger, forkFn = fork } = this.params;
    const { elasticsearch: es } = settings;
    const child = forkFn(bundle.file, [], {
      // Credentials travel in the environment, never on the command line.
      env: {
        ...process.env,
        ES_URL: es.url,
        ...(es.api_key ? { ES_API_KEY: es.api_key } : {}),
        ...(es.username ? { ES_USERNAME: es.username } : {}),
        ...(es.password ? { ES_PASSWORD: es.password } : {}),
        ...(settings.config_file ? { POD_CONFIG: settings.config_file } : {}),
        ...(settings.max_concurrency
          ? { POD_MAX_CONCURRENCY: String(settings.max_concurrency) }
          : {}),
        POD_AUTH_TOKEN: this.token,
        PORT: '0',
        POD_KIBANA_VERSION: dispatch.kibanaVersion,
        NODE_ENV: 'production',
      },
      execArgv: ['--max-semi-space-size=8'],
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    this.children.set(bundle.name, child);

    const readyTimer = setTimeout(() => {
      logger.error(`Task process ${bundle.name} did not become ready in time; stopping it`);
      child.kill('SIGKILL');
    }, READY_TIMEOUT_MS);

    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const ready = /^READY (\d+)$/m.exec(buffered);
      if (!ready || this.removeRoutes.has(bundle.name)) return;
      clearTimeout(readyTimer);
      this.restarts.delete(bundle.name);
      this.removeRoutes.set(
        bundle.name,
        dispatch.addRoute({
          url: `http://127.0.0.1:${ready[1]}`,
          task_types: bundle.taskTypes,
          token: this.token,
        })
      );
      logger.info(`Task process ${bundle.name} (pid ${child.pid}) serves ${bundle.taskTypes}`);
    });

    child.once('exit', (code, signal) => {
      clearTimeout(readyTimer);
      this.removeRoutes.get(bundle.name)?.();
      this.removeRoutes.delete(bundle.name);
      this.children.delete(bundle.name);
      if (this.stopping) return;
      const attempt = this.restarts.get(bundle.name) ?? 0;
      this.restarts.set(bundle.name, attempt + 1);
      const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
      logger.warn(
        `Task process ${bundle.name} exited (${
          signal ?? code
        }); its tasks run in Kibana, restarting in ${delay}ms`
      );
      setTimeout(() => !this.stopping && this.spawn(bundle), delay);
    });
  }
}
