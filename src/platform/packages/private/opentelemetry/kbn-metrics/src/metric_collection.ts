/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Attributes } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType } from '@opentelemetry/sdk-metrics';
import type {
  DataPoint,
  HistogramMetricData,
  MetricData,
  ScopeMetrics,
} from '@opentelemetry/sdk-metrics';

export interface MetricResourceSnapshot {
  resourceAttributes: Readonly<Attributes>;
  scopeMetrics: ScopeMetrics[];
}

type Operation = 'add' | 'subtract';
type Histogram = HistogramMetricData['dataPoints'][number]['value'];

const attributeKey = (attributes: Attributes): string =>
  JSON.stringify(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)));

const combine = (previous: number, current: number, operation: Operation): number =>
  operation === 'add' ? previous + current : current - previous;

const combineHistogram = (
  previous: Histogram,
  current: Histogram,
  operation: Operation
): Histogram => {
  if (JSON.stringify(previous.buckets.boundaries) !== JSON.stringify(current.buckets.boundaries)) {
    throw new Error('Native metric histogram boundaries changed');
  }
  return {
    buckets: {
      boundaries: [...current.buckets.boundaries],
      counts: current.buckets.counts.map((count, index) =>
        combine(previous.buckets.counts[index], count, operation)
      ),
    },
    count: combine(previous.count, current.count, operation),
    ...(current.sum !== undefined
      ? { sum: combine(previous.sum ?? 0, current.sum, operation) }
      : {}),
    ...(current.min !== undefined
      ? {
          min:
            operation === 'add' ? Math.min(previous.min ?? current.min, current.min) : current.min,
        }
      : {}),
    ...(current.max !== undefined
      ? {
          max:
            operation === 'add' ? Math.max(previous.max ?? current.max, current.max) : current.max,
        }
      : {}),
  };
};

const combinePoints = <T>(
  previous: readonly DataPoint<T>[],
  current: readonly DataPoint<T>[],
  operation: Operation,
  combineValues: (previous: T, current: T) => T,
  cardinalityLimit: number
): Array<DataPoint<T>> => {
  const existing = new Map(previous.map((point) => [attributeKey(point.attributes), point]));
  const result = operation === 'add' ? new Map(existing) : new Map<string, DataPoint<T>>();
  for (const original of current) {
    const overflow =
      operation === 'add' &&
      !result.has(attributeKey(original.attributes)) &&
      result.size >= cardinalityLimit - 1;
    const point = overflow
      ? { ...original, attributes: { 'otel.metric.overflow': true } }
      : original;
    const key = attributeKey(point.attributes);
    const before = operation === 'add' ? result.get(key) : existing.get(key);
    result.set(
      key,
      before
        ? {
            ...point,
            startTime: operation === 'add' ? before.startTime : before.endTime,
            value: combineValues(before.value, point.value),
          }
        : point
    );
  }
  return [...result.values()];
};

const combineMetric = (
  previous: MetricData,
  current: MetricData,
  operation: Operation,
  cardinalityLimit: number
): MetricData => {
  if (
    previous.descriptor.unit !== current.descriptor.unit ||
    previous.descriptor.valueType !== current.descriptor.valueType
  ) {
    throw new Error(`Native metric descriptor changed for ${current.descriptor.name}`);
  }
  const aggregationTemporality =
    operation === 'add' ? AggregationTemporality.CUMULATIVE : AggregationTemporality.DELTA;
  switch (current.dataPointType) {
    case DataPointType.SUM:
      if (
        previous.dataPointType !== DataPointType.SUM ||
        previous.isMonotonic !== current.isMonotonic
      )
        break;
      return {
        ...current,
        aggregationTemporality,
        dataPoints: combinePoints(
          previous.dataPoints,
          current.dataPoints,
          operation,
          (before, value) => combine(before, value, operation),
          cardinalityLimit
        ),
      };
    case DataPointType.GAUGE:
      if (previous.dataPointType !== DataPointType.GAUGE) break;
      return {
        ...current,
        aggregationTemporality,
        dataPoints: combinePoints(
          previous.dataPoints,
          current.dataPoints,
          operation,
          (_before, value) => value,
          cardinalityLimit
        ),
      };
    case DataPointType.HISTOGRAM:
      if (previous.dataPointType !== DataPointType.HISTOGRAM) break;
      return {
        ...current,
        aggregationTemporality,
        dataPoints: combinePoints(
          previous.dataPoints,
          current.dataPoints,
          operation,
          (before, value) => combineHistogram(before, value, operation),
          cardinalityLimit
        ),
      };
    case DataPointType.EXPONENTIAL_HISTOGRAM:
      throw new Error(
        'Native Prometheus aggregation requires the native explicit histogram reader'
      );
  }
  throw new Error(`Native metric type changed for ${current.descriptor.name}`);
};

/** Combines native Prometheus collections or computes the delta since the previous run snapshot. */
export const combineMetricCollections = (
  previous: readonly ScopeMetrics[],
  current: readonly ScopeMetrics[],
  operation: Operation = 'add',
  cardinalityLimit: number = Number.POSITIVE_INFINITY
): ScopeMetrics[] => {
  const scopeKey = (scope: ScopeMetrics['scope']): string => JSON.stringify(scope);
  const before = new Map(previous.map((scope) => [scopeKey(scope.scope), scope]));
  const result = operation === 'add' ? new Map(before) : new Map<string, ScopeMetrics>();
  for (const scope of current) {
    const key = scopeKey(scope.scope);
    const existing = before.get(key);
    const priorMetrics = new Map(
      existing?.metrics.map((metric) => [metric.descriptor.name, metric])
    );
    const metrics = operation === 'add' ? new Map(priorMetrics) : new Map<string, MetricData>();
    for (const metric of scope.metrics) {
      const prior = priorMetrics.get(metric.descriptor.name) ?? { ...metric, dataPoints: [] };
      metrics.set(
        metric.descriptor.name,
        combineMetric(prior, metric, operation, cardinalityLimit)
      );
    }
    result.set(key, { scope: scope.scope, metrics: [...metrics.values()] });
  }
  return [...result.values()];
};
