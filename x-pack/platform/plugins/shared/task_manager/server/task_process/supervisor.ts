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
import type { TaskProcessLease, TaskProcessRoute } from './remote_task_runner';
import { TaskProcessAcquireError } from './acquire_error';
import { getChildNodeOptions } from './child_node_options';
import { forwardChildLogs, getChildLogLevel } from './child_log_forwarder';
import type { SerializedElasticsearchConfig } from './es_config';
import type { TaskProcessInit, TaskProcessReady } from './wire';

/** `manifest.json` of a task bundle directory: which task types each bundle serves. */
export interface TaskBundleManifest {
  bundles: Record<string, { file: string; taskType: string }>;
}

export interface TaskProcessSettings {
  bundle_dir: string;
  kibanaVersion: string;
  /** Kibana's own Elasticsearch connection, which every process connects with. */
  getElasticsearchConfig: () => SerializedElasticsearchConfig;
  /** What else a task type's process needs, such as the keys and plugin settings it declared. */
  /** The most task processes that are alive for runs at once; a run past it goes to Kibana. Unbounded when unset. */
  maxConcurrentProcesses?: number;
  /** `--max-old-space-size` of each process, in MB. Without it a process uses Node's default, not Kibana's heap flags. */
  childMaxOldSpaceMb?: number;
  /** How long `stop` lets runs in flight finish before it kills their processes. */
  drainTimeoutMs?: number;
  getInitFor?: (
    taskType: string
  ) =>
    | Omit<TaskProcessInit, 'kind' | 'authToken' | 'elasticsearch' | 'kibanaVersion'>
    | Promise<Omit<TaskProcessInit, 'kind' | 'authToken' | 'elasticsearch' | 'kibanaVersion'>>;
}

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
/** After the drain bound, how long a process gets to exit on SIGTERM before it is killed. */
const DRAIN_KILL_GRACE_MS = 2_000;

/** What the supervisor has done since Kibana started. */
export interface TaskProcessSupervisorStats {
  /** Processes alive now, including ones that are shutting down. */
  live: number;
  /** Processes held by a run now; this is what `max` bounds. */
  active: number;
  max?: number;
  spawned: number;
  spawnFailures: number;
  spawnTimeouts: number;
  /** Runs turned away because `max` processes were active. */
  capacityRejections: number;
}

interface Bundle {
  name: string;
  file: string;
  taskType: string;
}

/**
 * Runs each run of a task type that has a bundle in a child process of Kibana that lives as long as
 * the run: it is forked when the run starts and stopped when the run ends. The same bundles run as
 * a remote process; only who starts them differs. When a process cannot be started the run goes to
 * Kibana, so a failing bundle never strands a task.
 */
export class TaskProcessSupervisor {
  private readonly token = randomBytes(32).toString('hex');
  private readonly children = new Set<ChildProcess>();
  private readonly bundleByTaskType = new Map<string, Bundle>();
  private stopping = false;
  private activeCount = 0;
  private readonly stats = {
    spawned: 0,
    spawnFailures: 0,
    spawnTimeouts: 0,
    capacityRejections: 0,
  };

  constructor(
    private readonly params: {
      settings: TaskProcessSettings;
      logger: Logger;
      /** Defaults to Node's `child_process.fork`; tests inject a fake. */
      forkFn?: typeof fork;
    }
  ) {}

  /** Reads which task types the bundles serve. No process starts until a run needs one. */
  public start() {
    const { settings, logger } = this.params;
    const manifestPath = join(settings.bundle_dir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(
        `No task bundle manifest at ${manifestPath}; build the bundles (node scripts/task_bundle) or set xpack.task_manager.task_execution.bundle_dir`
      );
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TaskBundleManifest;
    for (const [name, { file, taskType }] of Object.entries(manifest.bundles)) {
      this.bundleByTaskType.set(taskType, {
        name,
        file: join(settings.bundle_dir, file),
        taskType,
      });
    }
    logger.debug(`Task bundles serve ${[...this.bundleByTaskType.keys()]}`);
  }

  /** The route of a task type that has a bundle. */
  public getRoute(taskType: string): TaskProcessRoute | undefined {
    const bundle = this.bundleByTaskType.get(taskType);
    return bundle && !this.stopping
      ? { acquire: (context) => this.acquire(bundle, context) }
      : undefined;
  }

  public getStats(): TaskProcessSupervisorStats {
    return {
      live: this.children.size,
      active: this.activeCount,
      max: this.params.settings.maxConcurrentProcesses,
      ...this.stats,
    };
  }

  /**
   * Rejects new runs, gives the runs in flight `drainTimeoutMs` to finish (each stops its own process
   * when it ends), then stops what is left: SIGTERM, and SIGKILL if it does not exit.
   */
  public async stop() {
    this.stopping = true;
    const { logger, settings } = this.params;
    const drainMs = settings.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const live = [...this.children];
    if (live.length === 0) return;
    logger.debug(`Waiting up to ${drainMs}ms for ${live.length} task process(es) to finish`);
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.all(live.map((child) => this.exited(child))).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), drainMs);
      }),
    ]);
    clearTimeout(timer);
    if (drained) return;
    const remaining = [...this.children];
    logger.warn(
      `Stopping ${remaining.length} task process(es) that did not finish in ${drainMs}ms`
    );
    await Promise.all(remaining.map((child) => this.terminate(child, DRAIN_KILL_GRACE_MS)));
  }

  private exited(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
  }

  /** Starts a process for one run; releasing the lease stops it. */
  private async acquire(
    bundle: Bundle,
    context?: { executionUuid?: string }
  ): Promise<TaskProcessLease> {
    if (this.stopping) throw new TaskProcessAcquireError('unavailable', 'Kibana is shutting down');
    const { settings } = this.params;
    const max = settings.maxConcurrentProcesses;
    if (max !== undefined && this.activeCount >= max) {
      this.stats.capacityRejections++;
      throw new TaskProcessAcquireError(
        'capacity',
        `${this.activeCount} task processes are running, the most xpack.task_manager.task_execution.max_concurrent_processes allows (${max})`
      );
    }
    // Held from here, before anything is awaited, so concurrent runs cannot pass the cap together.
    this.activeCount++;
    let held = true;
    const giveBack = () => {
      if (!held) return;
      held = false;
      this.activeCount--;
    };
    try {
      return await this.spawn(bundle, context, giveBack);
    } catch (error) {
      giveBack();
      throw error;
    }
  }

  private async spawn(
    bundle: Bundle,
    context: { executionUuid?: string } | undefined,
    giveBack: () => void
  ): Promise<TaskProcessLease> {
    const { settings, logger, forkFn = fork } = this.params;
    // What Kibana has right now (its connectors, say), read before the process exists, so a failure
    // to read it leaves nothing running.
    const initOrPromise = settings.getInitFor?.(bundle.taskType);
    // Only what is asynchronous waits, so a process of settings known now starts at once.
    const init = initOrPromise instanceof Promise ? await initOrPromise : initOrPromise;
    if (this.stopping) throw new TaskProcessAcquireError('unavailable', 'Kibana is shutting down');
    const { execArgv, nodeOptions } = getChildNodeOptions({
      maxOldSpaceMb: settings.childMaxOldSpaceMb,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: '0',
      // Logs are records in Kibana's JSON layout that Kibana logs again with its own logger.
      TASK_PROCESS_LOG_LAYOUT: 'json',
      TASK_PROCESS_LOG_LEVEL: getChildLogLevel(logger),
    };
    if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
    else delete env.NODE_OPTIONS;
    const child = forkFn(bundle.file, [], {
      env,
      execArgv,
      // stdout and stderr are read here; the fork channel carries the settings and readiness.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.stats.spawned++;
    // An unhandled error event would take Kibana down.
    child.on('error', (error) =>
      logger.debug(`Task process ${bundle.name} error: ${error.message}`)
    );
    this.children.add(child);
    const labels = {
      task_type: bundle.taskType,
      ...(context?.executionUuid ? { run_id: context.executionUuid } : {}),
    };
    const childLogger = logger.get('task_process');
    const stopForwarding = [
      child.stdout && forwardChildLogs({ stream: child.stdout, logger: childLogger, labels }),
      child.stderr &&
        forwardChildLogs({
          stream: child.stderr,
          logger: childLogger,
          labels,
          fallbackLevel: 'warn',
        }),
    ];
    child.once('exit', () => {
      this.children.delete(child);
      giveBack();
      logger.debug(
        `Task process ${child.pid} for ${bundle.taskType} exited; ${this.children.size} live`
      );
      // What the child wrote before it exited is read before the streams close.
      setImmediate(() => stopForwarding.forEach((stop) => stop?.()));
    });
    logger.debug(
      `Task process ${child.pid} started for ${bundle.taskType}; ${this.children.size} live (${this.activeCount} held by runs)`
    );

    const port = await new Promise<number>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        this.stats.spawnTimeouts++;
        // Rejected first: killing the process also emits its exit.
        reject(
          new TaskProcessAcquireError(
            'spawn_timeout',
            `Task process ${bundle.name} did not become ready in time`
          )
        );
        child.kill('SIGKILL');
      }, READY_TIMEOUT_MS);
      const failed = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.stats.spawnFailures++;
        reject(new TaskProcessAcquireError('spawn_failed', message));
      };
      child.once('exit', (code, signal) =>
        failed(`Task process ${bundle.name} exited (${signal ?? code}) before it was ready`)
      );
      // `fork` reports a process that cannot be spawned (no such executable) as an error event.
      child.once('error', (error) =>
        failed(`Task process ${bundle.name} could not be started: ${error.message}`)
      );
      child.on('message', (message: TaskProcessReady) => {
        if (message?.kind !== 'ready') return;
        settled = true;
        clearTimeout(timer);
        resolve(message.port);
      });
      child.send({
        kind: 'init',
        ...init,
        elasticsearch: settings.getElasticsearchConfig(),
        kibanaVersion: settings.kibanaVersion,
        authToken: this.token,
      } satisfies TaskProcessInit);
    }).catch((error) => {
      logger.warn(`${error.message}; the run goes to Kibana`);
      this.terminate(child);
      throw error;
    });

    return {
      url: `http://127.0.0.1:${port}`,
      token: this.token,
      release: () => {
        giveBack();
        this.terminate(child);
      },
    };
  }

  /** Asks the process to exit, and kills it if it does not. */
  private terminate(child: ChildProcess, killAfterMs = STOP_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
