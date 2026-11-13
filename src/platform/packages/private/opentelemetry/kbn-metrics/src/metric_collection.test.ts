/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { ValueType } from '@opentelemetry/api';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import type { ScopeMetrics } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus';
import { combineMetricCollections } from './metric_collection';

class SnapshotReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

const providers: MeterProvider[] = [];
const resource = resourceFromAttributes({ 'service.name': 'kibana' });
const serializer = new PrometheusSerializer('', false, undefined, true, true);
const render = (scopeMetrics: ScopeMetrics[]): string =>
  serializer.serialize({ resource, scopeMetrics });
const create = (boundaries = [10, 20], cardinalityLimit?: number) => {
  const reader = new SnapshotReader(
    cardinalityLimit === undefined ? undefined : { cardinalitySelector: () => cardinalityLimit }
  );
  const provider = new MeterProvider({ readers: [reader], resource });
  providers.push(provider);
  const meter = provider.getMeter('kibana.metric_collection');
  const options = {
    description: 'Native SDK aggregation fixture',
    unit: '1',
    valueType: ValueType.INT,
  };
  return {
    counter: meter.createCounter('test.counter', options),
    gauge: meter.createGauge('test.gauge', options),
    upDown: meter.createUpDownCounter('test.up_down', options),
    histogram: meter.createHistogram('test.duration', {
      ...options,
      advice: { explicitBucketBoundaries: boundaries },
    }),
    collect: async () => (await reader.collect()).resourceMetrics.scopeMetrics,
  };
};

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
});

it('recovers native cumulative output from successive snapshots without double counting', async () => {
  const source = create();
  source.counter.add(2, { beta: 'b', alpha: 'a' });
  source.upDown.add(3);
  source.gauge.record(7);
  source.histogram.record(10);
  const before = await source.collect();
  source.counter.add(3, { alpha: 'a', beta: 'b' });
  source.upDown.add(-1);
  source.gauge.record(4);
  source.histogram.record(20);
  const current = await source.collect();
  const delta = combineMetricCollections(before, current, 'subtract');
  expect(render(combineMetricCollections(before, delta))).toBe(render(current));
  expect(
    render(combineMetricCollections(before, combineMetricCollections(before, before, 'subtract')))
  ).toBe(render(before));
});

it('matches a native in-process provider for counters, gauges and histogram distributions across workers', async () => {
  const first = create();
  const second = create();
  const baseline = create();
  first.counter.add(2);
  first.upDown.add(3);
  first.gauge.record(7);
  first.histogram.record(10);
  second.counter.add(3);
  second.upDown.add(1);
  second.gauge.record(9);
  second.histogram.record(20);
  baseline.counter.add(5);
  baseline.upDown.add(4);
  baseline.gauge.record(9);
  baseline.histogram.record(10);
  baseline.histogram.record(20);
  const combined = combineMetricCollections(await first.collect(), await second.collect());
  expect(render(combined)).toBe(render(await baseline.collect()));
});

it('rejects inconsistent native histogram boundaries instead of corrupting bucket counts', async () => {
  const first = create([10, 20]);
  const second = create([10, 50]);
  first.histogram.record(15);
  second.histogram.record(30);
  const before = await first.collect();
  const current = await second.collect();
  expect(() => combineMetricCollections(before, current)).toThrow('histogram boundaries changed');
});

it('matches the native SDK overflow series when workers together exceed its cardinality limit', async () => {
  const first = create([10, 20], 4);
  const second = create([10, 20], 4);
  const baseline = create([10, 20], 4);
  for (const label of [0, 1, 2]) first.counter.add(1, { label });
  for (const label of [3, 4, 5]) second.counter.add(1, { label });
  for (const label of [0, 1, 2, 3, 4, 5]) baseline.counter.add(1, { label });
  expect(
    render(combineMetricCollections(await first.collect(), await second.collect(), 'add', 4))
  ).toBe(render(await baseline.collect()));
});
