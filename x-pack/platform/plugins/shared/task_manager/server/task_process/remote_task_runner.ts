/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Agent } from 'undici';
import type { CancellableTask, RemoteRunObserver, RunResult } from '../task';
import {
  createRetryableError,
  deserializeTaskRunError,
  throwUnrecoverableError,
} from '../task_running/errors';
import { TaskProcessAcquireError } from './acquire_error';
import type { TaskProcessDispatchFailureReason } from './dispatch_failure_counter';
import { DECLINED_STATUS, deserializeRunResult, MAX_TIMER_MS } from './wire';
import type {
  TaskProcessDispatchSnapshot,
  TaskProcessRunRequest,
  TaskProcessRunResponse,
} from './wire';

/** Where a run goes: its address, and the bearer token the process requires. */
export interface TaskProcessAddress {
  url: string;
  token?: string;
}

/** An address held for one run; releasing it retires the child or returns it to the idle pool. */
export interface TaskProcessLease extends TaskProcessAddress {
  release(options?: { force?: boolean; reusable?: boolean }): void;
}

/**
 * A remote process Kibana reaches at a fixed address, or a process Kibana starts when a run needs it:
 * `acquire` starts it if it is not running, and rejects if it cannot be started.
 */
export type TaskProcessRoute =
  | TaskProcessAddress
  | { acquire: (context?: TaskProcessAcquireContext) => Promise<TaskProcessLease> };

export interface TaskProcessAcquireContext {
  executionUuid?: string;
  snapshot?: TaskProcessDispatchSnapshot;
}

/** Where a task type runs when it is not run in this process. */
export interface TaskProcessDispatch {
  /** The route of a task type, or nothing when it runs in this process. */
  getRoute(taskType: string): TaskProcessRoute | undefined;
  /** The Kibana version dispatching the run; a process built from another version refuses it. */
  kibanaVersion: string;
  /** The values of the feature flags a task type declares, for the run being dispatched. */
  getFeatureFlags?: (taskType: string) => Promise<TaskProcessRunRequest['featureFlags']>;
  getSnapshot?: (taskType: string) => Promise<TaskProcessDispatchSnapshot>;
  getCancelGracePeriodMs?: (taskType: string) => number | undefined;
  /** Called when dispatch fails; the task remains assigned to process execution. */
  onDispatchFailure?: (
    taskType: string,
    reason: TaskProcessDispatchFailureReason,
    detail?: string
  ) => void;
}

const authHeaders = (address: TaskProcessAddress): Record<string, string> =>
  address.token ? { authorization: `Bearer ${address.token}` } : {};

/** How long Kibana waits past a task's timeout for the process to answer before giving up. */
const DEADLINE_GRACE_MS = 5000;
/** How soon a task is retried when its process could not be reached or refused the run. */
const UNAVAILABLE_RETRY_MS = 5000;

// A run can legitimately take longer than undici's default 5 minute header timeout; the task's own
// timeout (via the abort signal) is what bounds it.
let longRunDispatcher: Agent | undefined;
const getLongRunDispatcher = () =>
  (longRunDispatcher ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

/** An abort signal that fires after `ms`, or when `parent` aborts; `dispose` clears the timer. */
const abortAfter = (ms: number, parent?: AbortSignal) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(ms, MAX_TIMER_MS));
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
};

const processUnavailable = (message: string) =>
  createRetryableError(new Error(message), new Date(Date.now() + UNAVAILABLE_RETRY_MS));

/**
 * Drop-in for the `{ run, cancel }` object `definition.createTaskRunner(...)` returns: the run
 * happens in a task process, and the result or error is rebuilt so Task Manager's own
 * `processResult` handles it exactly as it would a local run.
 */
export class RemoteTaskRunner implements CancellableTask {
  constructor(
    private readonly params: {
      route: TaskProcessRoute;
      request: Omit<TaskProcessRunRequest, 'deadline'>;
      /** The task's timeout; the process is told to stop, and Kibana stops waiting, shortly after. */
      timeoutMs: number;
      /** Aborted when Task Manager cancels the run. */
      signal?: AbortSignal;
      setCustomTaskRunEventFields: (fields: Record<string, unknown>) => void;
      /** Told when dispatch fails, and why. */
      onDispatchFailure?: TaskProcessDispatch['onDispatchFailure'];
      /** What the task type counts in Kibana's memory of the runs a process served. */
      observer?: RemoteRunObserver;
      fetchFn?: typeof fetch;
    }
  ) {}

  private cancelled = false;
  private target?: TaskProcessAddress | TaskProcessLease;
  private cancellation?: Promise<void>;

  public async run(): Promise<RunResult | undefined | void> {
    const { route, request, timeoutMs, signal, setCustomTaskRunEventFields } = this.params;
    signal?.throwIfAborted();
    if (this.cancelled)
      throw createRetryableError(new Error('Task process run was cancelled'), false);
    const deadline = new Date(Date.now() + timeoutMs);
    const fetchFn = this.params.fetchFn ?? fetch;

    let lease: TaskProcessLease | undefined;
    let address: TaskProcessAddress;
    if ('acquire' in route) {
      try {
        lease = await route.acquire({
          executionUuid: request.executionUuid,
          snapshot: request.snapshot,
        });
      } catch (error) {
        this.params.onDispatchFailure?.(
          request.taskType,
          error instanceof TaskProcessAcquireError ? error.reason : 'unavailable',
          `the process could not be started: ${(error as Error).message}`
        );
        if (error instanceof TaskProcessAcquireError && error.reason === 'not_served') {
          throwUnrecoverableError(error);
        }
        throw processUnavailable(`Task process could not be started: ${(error as Error).message}`);
      }
      address = lease;
    } else {
      address = route;
    }
    if (this.cancelled || signal?.aborted || deadline.getTime() <= Date.now()) {
      lease?.release({ force: true });
      signal?.throwIfAborted();
      throw createRetryableError(
        new Error('Task process run was cancelled or timed out before dispatch'),
        false
      );
    }
    this.target = address;
    const { signal: abort, dispose } = abortAfter(
      deadline.getTime() - Date.now() + DEADLINE_GRACE_MS,
      signal
    );
    let reusable = false;
    try {
      let response: Response;
      try {
        response = await fetchFn(`${address.url}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders(address) },
          body: JSON.stringify({
            ...request,
            // Acquired children already received initialization secrets over IPC.
            ...('acquire' in route ? { snapshot: undefined } : {}),
            deadline: deadline.toISOString(),
          } satisfies TaskProcessRunRequest),
          signal: abort,
          ...(this.params.fetchFn ? {} : { dispatcher: getLongRunDispatcher() }),
        } as RequestInit);
      } catch (error) {
        // Timed out or cancelled: Task Manager's own timeout handling owns that outcome.
        if (abort.aborted) throw error;
        this.params.onDispatchFailure?.(
          request.taskType,
          'unavailable',
          'Task process is unreachable'
        );
        throw processUnavailable(
          `Task process ${address.url} is unreachable: ${(error as Error).message}`
        );
      }
      if (!response.ok) {
        // A process that declines says why, which is what to alarm on.
        let reason: string | undefined;
        if (response.status === DECLINED_STATUS) {
          reason = (
            (await response.json().catch(() => undefined)) as { reason?: string } | undefined
          )?.reason;
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
        const message = `Task process ${address.url} responded ${response.status} to /run${
          reason ? `: ${reason}` : ''
        }`;
        if (response.status === 404 || response.status === DECLINED_STATUS) {
          this.params.onDispatchFailure?.(
            request.taskType,
            response.status === DECLINED_STATUS ? 'declined' : 'not_served',
            reason
          );
          throwUnrecoverableError(new Error(message));
        }
        this.params.onDispatchFailure?.(request.taskType, 'unavailable', message);
        // A busy or draining process can serve the task on a later attempt.
        if (response.status === 503) {
          throw processUnavailable(message);
        }
        throwUnrecoverableError(new Error(message));
      }
      const body = (await response.json()) as TaskProcessRunResponse;
      if (body.customTaskRunEventFields) {
        setCustomTaskRunEventFields(body.customTaskRunEventFields);
      }
      if (body.kind === 'thrown') {
        throw deserializeTaskRunError(body.error);
      }
      const result = deserializeRunResult(body.result);
      reusable = body.reusable === true && !body.result?.error && !body.result?.taskRunError;
      // A run Kibana cancelled is not counted as run, as when Kibana runs it itself.
      if (!this.cancelled) this.observe((observer) => observer.onResult?.(result));
      return result;
    } finally {
      dispose();
      if (abort.aborted || this.cancelled) await this.cancel();
      else lease?.release({ reusable });
    }
  }

  /** What the type counts must never fail a run. */
  private observe(call: (observer: RemoteRunObserver) => void) {
    try {
      if (this.params.observer) call(this.params.observer);
    } catch (error) {
      // Counting is best effort.
    }
  }

  public async cancel() {
    const { request } = this.params;
    const address = this.target;
    const wasCancelled = this.cancelled;
    this.cancelled = true;
    // Not started yet: nothing to cancel.
    if (!address) return;
    if (!wasCancelled) {
      this.observe((observer) => observer.onCancel?.());
    }
    if ('release' in address && !request.cancelGracePeriodMs) {
      address.release({ force: true });
      return;
    }
    return (this.cancellation ??= this.cancelTarget(address));
  }

  private async cancelTarget(address: TaskProcessAddress | TaskProcessLease): Promise<void> {
    const { request } = this.params;
    const fetchFn = this.params.fetchFn ?? fetch;
    try {
      const { signal, dispose } = abortAfter(request.cancelGracePeriodMs ?? DEADLINE_GRACE_MS);
      try {
        const response = await fetchFn(`${address.url}/cancel/${request.executionUuid}`, {
          method: 'POST',
          headers: authHeaders(address),
          signal,
        });
        await response.body?.cancel();
      } finally {
        dispose();
      }
    } catch {
      // The process may be gone; Task Manager's own timeout handling already owns the outcome.
    } finally {
      if ('release' in address) address.release({ force: true });
    }
  }
}
