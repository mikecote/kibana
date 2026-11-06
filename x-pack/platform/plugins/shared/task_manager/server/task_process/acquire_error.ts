/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskProcessFallbackReason } from './fallback_counter';

/** Thrown by a route's `acquire` when it cannot give a process; the reason is what gets counted. */
export class TaskProcessAcquireError extends Error {
  constructor(public readonly reason: TaskProcessFallbackReason, message: string) {
    super(message);
  }
}
