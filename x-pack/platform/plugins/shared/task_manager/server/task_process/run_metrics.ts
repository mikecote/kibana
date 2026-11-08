/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  combineMetricCollections,
  encodeMetricScopes,
  DEFAULT_METRIC_CARDINALITY_LIMIT,
} from '@kbn/metrics';
import type { ScopeMetrics } from '@kbn/metrics';
import type { TaskProcessMetricSnapshot } from './wire';

/** Keeps one execution's native metric snapshots ordered through progress and final responses. */
export class TaskProcessMetrics {
  private current?: { sequence: number; scopes: ScopeMetrics[] };
  private queue: Promise<void> = Promise.resolve();
  private pending?: Promise<TaskProcessMetricSnapshot | undefined>;
  private finalized?: Promise<TaskProcessMetricSnapshot | undefined>;

  constructor(private readonly collector?: () => Promise<ScopeMetrics[]>) {}

  public addDelta(scopes: ScopeMetrics[]): void {
    if (this.finalized) throw new Error('Cannot publish metrics after execution finalization');
    this.current = {
      sequence: (this.current?.sequence ?? 0) + 1,
      scopes: combineMetricCollections(
        this.current?.scopes ?? [],
        scopes,
        'add',
        DEFAULT_METRIC_CARDINALITY_LIMIT
      ),
    };
  }

  public snapshot(): TaskProcessMetricSnapshot | undefined {
    return this.current
      ? { sequence: this.current.sequence, encoded: encodeMetricScopes(this.current.scopes) }
      : undefined;
  }

  public collect(final: boolean = false): Promise<TaskProcessMetricSnapshot | undefined> {
    if (this.finalized) return this.finalized;
    if (!final && this.pending) return this.pending;
    const collected = this.queue.then(async () => {
      if (this.collector) {
        const scopes = await this.collector();
        // The final collection already owns the queue; only its native delta may still be added.
        this.current = {
          sequence: (this.current?.sequence ?? 0) + 1,
          scopes: combineMetricCollections(
            this.current?.scopes ?? [],
            scopes,
            'add',
            DEFAULT_METRIC_CARDINALITY_LIMIT
          ),
        };
      }
      return this.snapshot();
    });
    this.queue = collected.then(
      () => undefined,
      () => undefined
    );
    if (final) this.finalized = collected;
    else {
      this.pending = collected;
      const clear = (): void => {
        if (this.pending === collected) this.pending = undefined;
      };
      void collected.then(clear, clear);
    }
    return collected;
  }
}
