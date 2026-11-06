/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export type TaskProcessFallbackReason = 'declined' | 'not_served' | 'unavailable';

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
    const counts = this.counts.get(taskType) ?? { declined: 0, not_served: 0, unavailable: 0 };
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
