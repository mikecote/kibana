/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  AggregationTemporality,
  MetricReader,
  InstrumentType,
  AggregationType,
} from '@opentelemetry/sdk-metrics';
import type { AggregationOption } from '@opentelemetry/sdk-metrics';

/** Collects native sums and histogram deltas for execution handoff. */
export class DeltaMetricReader extends MetricReader {
  public selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return instrumentType === InstrumentType.GAUGE ||
      instrumentType === InstrumentType.OBSERVABLE_GAUGE
      ? { type: AggregationType.DROP }
      : super.selectAggregation(instrumentType);
  }

  public selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA;
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** The actual SDK default used by native process and Prometheus readers. */
export const DEFAULT_METRIC_CARDINALITY_LIMIT = new DeltaMetricReader().selectCardinalityLimit(
  InstrumentType.COUNTER
);
