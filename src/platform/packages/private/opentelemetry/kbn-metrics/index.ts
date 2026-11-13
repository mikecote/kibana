/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

export { initMetrics, type InitMetricsOptions } from './src/init_metrics';
export { PrometheusExporter } from './src/prometheus_exporter';

export { DeltaMetricReader, DEFAULT_METRIC_CARDINALITY_LIMIT } from './src/delta_metric_reader';
export { combineMetricCollections } from './src/metric_collection';
export type { ScopeMetrics } from '@opentelemetry/sdk-metrics';

export type { MetricResourceSnapshot } from './src/metric_collection';

export {
  encodeMetricScopes,
  decodeMetricScopes,
  encodeMetricResources,
  decodeMetricResources,
  METRIC_SERIALIZATION_VERSION,
} from './src/metric_codec';

export { GaugeMetricReader } from './src/gauge_metric_reader';
