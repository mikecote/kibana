/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { resourceFromAttributes } from '@opentelemetry/resources';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { KibanaResponse, kibanaResponseFactory } from '@kbn/core-http-router-server-internal';
import { DeltaMetricReader, GaugeMetricReader, PrometheusExporter } from '@kbn/metrics';

const providers: MeterProvider[] = [];
const create = <T extends MetricReader>(reader: T, instance: string) => {
  const provider = new MeterProvider({
    readers: [reader],
    resource: resourceFromAttributes({
      'service.name': 'kibana',
      'service.instance.id': instance,
    }),
  });
  providers.push(provider);
  return { reader, meter: provider.getMeter('kibana.test') };
};

const scrape = async (exporter: PrometheusExporter): Promise<string> => {
  const response = await exporter.exportMetrics(kibanaResponseFactory);
  if (
    !(response instanceof KibanaResponse) ||
    response.status !== 200 ||
    typeof response.payload !== 'string'
  ) {
    throw new Error('The native Prometheus exporter did not return its text response');
  }
  return response.payload;
};

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  PrometheusExporter.destroy();
});

it('retains native task totals after exit and collects each live worker gauge with its resource identity', async () => {
  const exporter = PrometheusExporter.get();
  const main = create(exporter, 'main');
  main.meter
    .createGauge('kibana.test.load', { description: 'Native process gauge', unit: '1' })
    .record(31);
  const deltas = create(new DeltaMetricReader(), 'first');
  const workerCounter = deltas.meter.createCounter('kibana.test.run.count', {
    description: 'Native run counter',
    unit: '1',
  });
  const workerHistogram = deltas.meter.createHistogram('kibana.test.duration', {
    description: 'Native execution duration',
    unit: 'ms',
  });
  const first = create(new GaugeMetricReader(), 'first');
  const second = create(new GaugeMetricReader(), 'second');
  first.meter
    .createGauge('kibana.test.load', { description: 'Native process gauge', unit: '1' })
    .record(7);
  second.meter
    .createGauge('kibana.test.load', { description: 'Native process gauge', unit: '1' })
    .record(9);
  const live = [first, second];
  const unregister = exporter.registerGaugeSource(async () =>
    Promise.all(
      live.map(async ({ reader }) => {
        const { resourceMetrics } = await reader.collect();
        return {
          resourceAttributes: resourceMetrics.resource.attributes,
          scopeMetrics: resourceMetrics.scopeMetrics,
        };
      })
    )
  );
  workerCounter.add(2);
  workerHistogram.record(10);
  exporter.addMetrics((await deltas.reader.collect()).resourceMetrics.scopeMetrics);
  workerCounter.add(3);
  workerHistogram.record(20);
  exporter.addMetrics((await deltas.reader.collect()).resourceMetrics.scopeMetrics);
  const before = await scrape(exporter);
  expect(before).toMatch(/kibana_test_run_count_total\{[^\n]*\} 5/);
  expect(before).toMatch(/kibana_test_duration_count\{[^\n]*\} 2/);
  expect(
    before
      .split('\n')
      .some(
        (line) =>
          line.startsWith('kibana_test_load{') &&
          line.includes('service_instance_id="first"') &&
          line.endsWith(' 7')
      )
  ).toBe(true);
  expect(
    before
      .split('\n')
      .some(
        (line) =>
          line.startsWith('kibana_test_load{') &&
          line.includes('service_instance_id="second"') &&
          line.endsWith(' 9')
      )
  ).toBe(true);
  const metadata = before
    .split('\n')
    .flatMap((line) => line.match(/^# (?:HELP|TYPE) \S+/)?.[0] ?? []);
  expect(new Set(metadata).size).toBe(metadata.length);
  live.length = 0;
  const after = await scrape(exporter);
  expect(after).toMatch(/kibana_test_run_count_total\{[^\n]*\} 5/);
  expect(after).not.toContain('service_instance_id="first"');
  expect(after).not.toContain('service_instance_id="second"');
  unregister();
});
