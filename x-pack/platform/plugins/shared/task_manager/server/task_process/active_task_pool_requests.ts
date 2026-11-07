/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';

interface PendingPoolRequest {
  id: string;
  promise: Promise<string[]>;
  resolve: (executionIds: string[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Requests fresh dispatch-pool metadata through the authenticated execution control channel. */
export class ActiveTaskPoolRequests {
  private pending?: PendingPoolRequest;
  private closed = false;
  private readonly onAbort = () => this.dispose();

  constructor(private readonly signal: AbortSignal, private readonly timeoutMs = 5000) {
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  public readonly getCurrentTasksInPool = (): Promise<string[]> => {
    this.signal.throwIfAborted();
    if (this.closed) return Promise.reject(new Error('The task execution has finished'));
    if (this.pending) return this.pending.promise;
    const { promise, resolve, reject } = Promise.withResolvers<string[]>();
    const id = randomUUID();
    const timer = setTimeout(() => {
      this.pending = undefined;
      reject(new Error('The dispatching Task Manager did not answer the active-pool request'));
    }, this.timeoutMs);
    timer.unref?.();
    this.pending = { id, promise, resolve, reject, timer };
    return promise;
  };

  public getRequestIds(): string[] {
    return this.pending ? [this.pending.id] : [];
  }

  public completeRequest(id: string, executionIds: readonly string[]): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== id) return false;
    clearTimeout(pending.timer);
    this.pending = undefined;
    pending.resolve([...executionIds]);
    return true;
  }

  public dispose(): void {
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new Error('The task execution ended before its active-pool request completed'));
  }
}
