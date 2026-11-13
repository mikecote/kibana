/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  MetricReader,
  AggregationTemporality,
  DataPointType,
  InstrumentType,
} from '@opentelemetry/sdk-metrics';
import type { ScopeMetrics } from '@opentelemetry/sdk-metrics';
import {
  PrometheusExporter as OpenTelemetryPrometheusExporter,
  PrometheusSerializer,
} from '@opentelemetry/exporter-prometheus';
import type { KibanaResponseFactory } from '@kbn/core-http-server';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { combineMetricCollections } from './metric_collection';
import type { MetricResourceSnapshot } from './metric_collection';

/**
 * Prometheus exporter for OpenTelemetry with a custom extension to collect the metrics whenever
 * the Prometheus HTTP endpoint is called.
 *
 * The Prometheus HTTP endpoint is registered in the plugin monitoringCollection.
 * @privateRemarks x-pack/platform/plugins/private/monitoring_collection/server/routes/api/v1/prometheus/get_metrics.ts
 */
export class PrometheusExporter extends MetricReader {
  /**
   * The singleton PrometheusExporter instance.
   * @private
   */
  static #instance?: PrometheusExporter;

  /**
   * Gets the singleton PrometheusExporter instance.
   */
  static get() {
    if (!this.#instance) {
      this.#instance = new PrometheusExporter();
    }
    return this.#instance;
  }

  /**
   * Destroys the singleton PrometheusExporter instance.
   * @privateRemarks Mostly used for testing purposes because the same exporter cannot be reassigned to new MetricsProvider.
   */
  static destroy() {
    this.#instance?.shutdown();
    this.#instance = undefined;
  }

  private readonly prefix: string;
  private readonly appendTimestamp: boolean;
  private serializer: PrometheusSerializer;
  private externalMetrics: ScopeMetrics[] = [];
  private readonly gaugeSources = new Set<() => Promise<MetricResourceSnapshot[]>>();
  private readonly gaugeSerializer: PrometheusSerializer;

  /** Registers an actual live-worker collection source for this node's Prometheus endpoint. */
  public registerGaugeSource(source: () => Promise<MetricResourceSnapshot[]>): () => void {
    this.gaugeSources.add(source);
    return () => {
      this.gaugeSources.delete(source);
    };
  }

  /** Adds native execution deltas to this node's cumulative Prometheus collection. */
  public addMetrics(metrics: readonly ScopeMetrics[]): void {
    if (
      metrics.some((scope) =>
        scope.metrics.some((metric) => metric.dataPointType === DataPointType.GAUGE)
      )
    ) {
      throw new Error('Live gauges require native resource collection');
    }
    this.externalMetrics = combineMetricCollections(
      this.externalMetrics,
      metrics,
      'add',
      this.selectCardinalityLimit(InstrumentType.COUNTER)
    );
  }

  private constructor() {
    super();
    this.prefix = OpenTelemetryPrometheusExporter.DEFAULT_OPTIONS.prefix;
    this.appendTimestamp = OpenTelemetryPrometheusExporter.DEFAULT_OPTIONS.appendTimestamp;

    this.serializer = new PrometheusSerializer(this.prefix, this.appendTimestamp);
    this.gaugeSerializer = new PrometheusSerializer(
      this.prefix,
      this.appendTimestamp,
      /^service\.instance\.id$/
    );
  }

  /**
   * Forces the AggregationTemporality to be CUMULATIVE (as required by the Prometheus format).
   */
  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  /**
   * Implementation of the MetricReader interface onForceFlush (noop).
   * @protected
   */
  protected onForceFlush(): Promise<void> {
    return Promise.resolve(undefined);
  }

  /**
   * Implementation of the MetricReader interface onShutdown (noop).
   * @protected
   */
  protected onShutdown(): Promise<void> {
    return Promise.resolve(undefined);
  }

  /**
   * Responds to incoming message with current state of all metrics.
   * @param res {@link KibanaResponseFactory}
   */
  public async exportMetrics(res: KibanaResponseFactory) {
    try {
      const [collectionResult, sources] = await Promise.all([
        this.collect(),
        Promise.all([...this.gaugeSources].map((source) => source())),
      ]);
      const { resourceMetrics, errors } = collectionResult;
      if (errors.length) {
        return res.customError({
          statusCode: 500,
          body: `PrometheusExporter: Metrics collection errors ${errors}`,
        });
      }
      const parts = [
        this.serializer.serialize({
          ...resourceMetrics,
          scopeMetrics: combineMetricCollections(
            this.externalMetrics,
            resourceMetrics.scopeMetrics
          ),
        }),
      ];
      for (const source of sources.flat()) {
        if (
          typeof source.resourceAttributes['service.instance.id'] !== 'string' ||
          source.scopeMetrics.some((scope) =>
            scope.metrics.some((metric) => metric.dataPointType !== DataPointType.GAUGE)
          )
        ) {
          throw new Error('Live worker gauge collection has invalid native resource metadata');
        }
        parts.push(
          this.gaugeSerializer.serialize({
            resource: resourceFromAttributes(source.resourceAttributes),
            scopeMetrics: source.scopeMetrics,
          })
        );
      }
      const headers = new Set<string>();
      const result = parts
        .flatMap((part) =>
          part.split('\n').filter((line) => {
            const header = line.match(/^# (?:HELP|TYPE) \S+/)?.[0];
            if (!header) return true;
            if (headers.has(header)) return false;
            headers.add(header);
            return true;
          })
        )
        .join('\n');
      if (result === '') {
        return res.noContent();
      }
      return res.ok({
        body: result,
      });
    } catch (error) {
      return res.customError({
        statusCode: 500,
        body: {
          message: `PrometheusExporter: Failed to export metrics ${error}`,
        },
      });
    }
  }
}
