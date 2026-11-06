/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Why Kibana ran a task itself:
 * - `declined`: the process answered 422.
 * - `not_served`: the process answered 404.
 * - `capacity`: Kibana already has `max_concurrent_processes` live task processes.
 * - `spawn_failed`: the process exited before it was ready.
 * - `spawn_timeout`: the process was not ready in time.
 * - `unavailable`: anything else that kept a process from starting.
 */
export type TaskProcessFallbackReason =
  | 'declined'
  | 'not_served'
  | 'unavailable'
  | 'capacity'
  | 'spawn_failed'
  | 'spawn_timeout';

export const TASK_PROCESS_FALLBACK_REASONS: TaskProcessFallbackReason[] = [
  'declined',
  'not_served',
  'unavailable',
  'capacity',
  'spawn_failed',
  'spawn_timeout',
];

const emptyCounts = () =>
  Object.fromEntries(TASK_PROCESS_FALLBACK_REASONS.map((reason) => [reason, 0])) as Record<
    TaskProcessFallbackReason,
    number
  >;

/**
 * Counts the runs Kibana ran itself because their task process could not: a process that declined
 * (which should not happen: it is the safety net of the parity guard), did not serve the task type,
 * or could not be started. Each one is a rule run that did not get the isolation that was asked for,
 * so it is logged, per task type, to be alarmed on.
 */
export class TaskProcessFallbackCounter {
  private readonly counts = new Map<string, Record<TaskProcessFallbackReason, number>>();

  constructor(private readonly logger?: { warn: (message: string) => void }) {}

  public increment(taskType: string, reason: TaskProcessFallbackReason, detail?: string) {
    const counts = this.counts.get(taskType) ?? emptyCounts();
    counts[reason]++;
    this.counts.set(taskType, counts);
    this.logger?.warn(
      `Task ${taskType} ran in Kibana instead of its task process (${reason})${
        detail ? `: ${detail}` : ''
      }`
    );
  }

  /** Fallbacks since Kibana started, by task type. */
  public getCounts(): Record<string, Record<TaskProcessFallbackReason, number>> {
    return Object.fromEntries([...this.counts].map(([type, counts]) => [type, { ...counts }]));
  }
}
