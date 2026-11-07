/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Why a task could not be dispatched to its process:
 * - `declined`: the process answered 422.
 * - `not_served`: the process answered 404.
 * - `capacity`: Kibana already has `max_concurrent_processes` live task processes.
 * - `spawn_failed`: the process exited before it was ready.
 * - `spawn_timeout`: the process was not ready in time.
 * - `unavailable`: anything else that kept a process from starting.
 */
export type TaskProcessDispatchFailureReason =
  | 'declined'
  | 'not_served'
  | 'unavailable'
  | 'capacity'
  | 'spawn_failed'
  | 'spawn_timeout';

export const TASK_PROCESS_DISPATCH_FAILURE_REASONS: TaskProcessDispatchFailureReason[] = [
  'declined',
  'not_served',
  'unavailable',
  'capacity',
  'spawn_failed',
  'spawn_timeout',
];

const emptyCounts = () =>
  Object.fromEntries(TASK_PROCESS_DISPATCH_FAILURE_REASONS.map((reason) => [reason, 0])) as Record<
    TaskProcessDispatchFailureReason,
    number
  >;

/** Counts process dispatch failures by task type and reason. */
export class TaskProcessDispatchFailureCounter {
  private readonly counts = new Map<string, Record<TaskProcessDispatchFailureReason, number>>();

  constructor(private readonly logger?: { warn: (message: string) => void }) {}

  public increment(
    taskType: string,
    reason: TaskProcessDispatchFailureReason,
    detail?: string
  ): void {
    const counts = this.counts.get(taskType) ?? emptyCounts();
    counts[reason]++;
    this.counts.set(taskType, counts);
    this.logger?.warn(
      `Task ${taskType} could not run in its task process (${reason})${detail ? `: ${detail}` : ''}`
    );
  }

  /** Dispatch failures since Kibana started, by task type. */
  public getCounts(): Record<string, Record<TaskProcessDispatchFailureReason, number>> {
    return Object.fromEntries([...this.counts].map(([type, counts]) => [type, { ...counts }]));
  }
}
