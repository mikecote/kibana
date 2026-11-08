/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { MetricReader, InstrumentType, AggregationType } from '@opentelemetry/sdk-metrics';
import type { AggregationOption } from '@opentelemetry/sdk-metrics';

/** Collects live process gauges without transferring their values into execution totals. */
export class GaugeMetricReader extends MetricReader {
  public selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return instrumentType === InstrumentType.GAUGE ||
      instrumentType === InstrumentType.OBSERVABLE_GAUGE
      ? super.selectAggregation(instrumentType)
      : { type: AggregationType.DROP };
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}
