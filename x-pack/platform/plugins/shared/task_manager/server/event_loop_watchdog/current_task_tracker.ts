/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/*
 * Runs on the *main* thread. Keeps a `SharedArrayBuffer` slot (`CURRENT_TASK_HANDLE_SLOT`)
 * stamped with the handle of whichever task run's context the main thread is currently
 * executing inside. This is what lets the watchdog worker read, at the moment it detects a
 * stale heartbeat, exactly which task's synchronous continuation froze the loop - rather
 * than only a list of tasks that happened to be in flight (see `report.ts`'s
 * `snapshotSuspects` for that fallback).
 *
 * Context propagation itself is delegated entirely to `AsyncLocalStorage`: an earlier
 * version of this tracker hand-rolled propagation with `async_hooks`' `init`/`before`/
 * `after` and a `triggerAsyncId` -> handle map, which turned out to leak a run's handle
 * into whichever *caller* code later awaited that run's own result promise (the promise
 * representing "this task is done" is itself a `PROMISE` resource created while the
 * handle was active, so a naive map keyed by `triggerAsyncId` tags it, and anything
 * resuming from awaiting it inherits the handle too, forever). `AsyncLocalStorage` already
 * solves this correctly, so this tracker only adds two small things on top of it:
 *  - an `async_hooks` `before`/`after` hook (needed regardless, see the module's config
 *    doc) that mirrors `als.getStore()` into the shared slot on every async continuation,
 *    since the worker thread cannot call back into the main thread's `AsyncLocalStorage`;
 *  - an explicit stamp/restore around the *synchronous* portion of `run()`, because
 *    `before`/`after` only fire for actual async resource callbacks, not for this direct
 *    synchronous call into `als.run()`.
 */

import { AsyncLocalStorage, createHook, type AsyncHook } from 'node:async_hooks';
import { CURRENT_TASK_HANDLE_SLOT, type TaskRunHandle } from './types';

/** `TaskRunScope` without the handle, since the caller (the watchdog) already owns that. */
export interface TrackedRun {
  run<T>(fn: () => Promise<T>): Promise<T>;
  end(): void;
}

/**
 * Tracks, via `AsyncLocalStorage`, which registered task run's context the main thread is
 * currently executing inside, and mirrors that into a shared-memory slot the watchdog
 * worker can read without any cooperation from the (possibly frozen) main thread.
 */
export class CurrentTaskTracker {
  private readonly als = new AsyncLocalStorage<TaskRunHandle>();
  private view?: Int32Array;
  private hook?: AsyncHook;

  /** Starts mirroring the current task handle into `sharedBuffer`. No-op if already enabled. */
  public enable(sharedBuffer: SharedArrayBuffer): void {
    if (this.hook) return;

    this.view = new Int32Array(sharedBuffer);
    this.storeHandle(0);

    // `before`/`after` fire for every async resource's callback in the process, not just
    // ones created under a tracked run; re-reading `als.getStore()` on each is what keeps
    // the slot correct as execution bounces between tracked and untracked code.
    this.hook = createHook({
      before: () => this.syncFromStore(),
      after: () => this.syncFromStore(),
    });
    this.hook.enable();
  }

  /** Stops tracking and clears the shared slot. Safe to call when not enabled. */
  public disable(): void {
    this.hook?.disable();
    this.hook = undefined;
    this.storeHandle(0);
    this.view = undefined;
  }

  /**
   * Returns a scope whose `run` executes callbacks with the shared slot stamped to
   * `handle` for their synchronous execution and every subsequent continuation, until the
   * callback (and anything it awaits) finishes.
   */
  public registerRun(handle: TaskRunHandle): TrackedRun {
    return {
      run: <T>(fn: () => Promise<T>): Promise<T> => {
        // The hook only fires for async resource callbacks, so the synchronous portion of
        // this call (up to `fn`'s first `await`, or all of `fn` if it never awaits) needs
        // an explicit stamp; `syncFromStore` in the `finally` restores whatever the
        // ambient context is once `als.run` itself returns control to the caller.
        this.storeHandle(handle);
        try {
          return this.als.run(handle, fn);
        } finally {
          this.syncFromStore();
        }
      },
      // Nothing to clean up: `AsyncLocalStorage` scopes itself to `run`'s dynamic extent,
      // with no persistent per-run bookkeeping to release. Kept for `TaskRunScope` symmetry.
      end: () => {},
    };
  }

  /** Exposed for tests: the handle currently stamped into the shared slot. */
  public getCurrentHandle(): TaskRunHandle {
    return this.view ? Atomics.load(this.view, CURRENT_TASK_HANDLE_SLOT) : 0;
  }

  private syncFromStore(): void {
    if (this.view) this.storeHandle(this.als.getStore() ?? 0);
  }

  private storeHandle(handle: TaskRunHandle): void {
    if (this.view) Atomics.store(this.view, CURRENT_TASK_HANDLE_SLOT, handle);
  }
}
