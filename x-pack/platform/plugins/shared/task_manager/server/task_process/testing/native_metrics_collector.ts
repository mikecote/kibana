/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { schema } from '@kbn/config-schema';
import type { TypeOf } from '@kbn/config-schema';

const attributesSchema = schema.arrayOf(
  schema.object({
    key: schema.string({ maxLength: 1024 }),
    value: schema.object(
      {
        stringValue: schema.maybe(schema.string({ maxLength: 4096 })),
        intValue: schema.maybe(schema.oneOf([schema.string({ maxLength: 32 }), schema.number()])),
        boolValue: schema.maybe(schema.boolean()),
      },
      { unknowns: 'ignore' }
    ),
  }),
  { maxSize: 256 }
);

const sumSchema = schema.object(
  {
    aggregationTemporality: schema.number(),
    dataPoints: schema.arrayOf(
      schema.object(
        {
          attributes: schema.maybe(attributesSchema),
          asInt: schema.maybe(schema.oneOf([schema.string({ maxLength: 32 }), schema.number()])),
          asDouble: schema.maybe(schema.number()),
        },
        { unknowns: 'ignore' }
      ),
      { maxSize: 100000 }
    ),
  },
  { unknowns: 'ignore' }
);

const metricSchema = schema.object(
  {
    name: schema.string({ maxLength: 1024 }),
    sum: schema.maybe(sumSchema),
  },
  { unknowns: 'ignore' }
);

const exportSchema = schema.object({
  resourceMetrics: schema.arrayOf(
    schema.object(
      {
        resource: schema.object({ attributes: attributesSchema }, { unknowns: 'ignore' }),
        scopeMetrics: schema.arrayOf(
          schema.object(
            {
              scope: schema.object(
                { name: schema.string({ maxLength: 1024 }) },
                { unknowns: 'ignore' }
              ),
              metrics: schema.arrayOf(metricSchema, { maxSize: 10000 }),
            },
            { unknowns: 'ignore' }
          ),
          { maxSize: 1000 }
        ),
      },
      { unknowns: 'ignore' }
    ),
    { maxSize: 1000 }
  ),
});

type MetricExport = TypeOf<typeof exportSchema>;
export interface NativeCounterSample {
  instanceId: string;
  name: string;
  temporality: number;
  value: number;
  attributes: TypeOf<typeof attributesSchema>;
}

/** Collects genuine native OTLP HTTP counter exports without replacing a provider or instrument. */
export const createNativeMetricsCollector = async (): Promise<{
  url: string;
  samples: NativeCounterSample[];
  errors: Error[];
  stop: () => Promise<void>;
}> => {
  const samples: NativeCounterSample[] = [];
  const errors: Error[] = [];
  const record = (exported: MetricExport): void => {
    for (const resource of exported.resourceMetrics) {
      const instanceId = resource.resource.attributes.find(
        ({ key }) => key === 'service.instance.id'
      )?.value.stringValue;
      if (!instanceId) throw new Error('Native metrics have no worker service.instance.id');
      for (const scope of resource.scopeMetrics) {
        for (const metric of scope.metrics) {
          if (!metric.sum) continue;
          for (const point of metric.sum.dataPoints) {
            const value = Number(point.asInt ?? point.asDouble);
            if (!Number.isFinite(value)) throw new Error('Invalid native counter value');
            samples.push({
              instanceId,
              name: metric.name,
              temporality: metric.sum.aggregationTemporality,
              value,
              attributes: point.attributes ?? [],
            });
          }
        }
      }
    }
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        request.destroy(new Error('OTLP metrics export exceeds collector limit'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', (error: Error) => errors.push(error));
    request.on('end', () => {
      try {
        if (request.method !== 'POST' || request.url !== '/v1/metrics') {
          response.writeHead(404).end();
          return;
        }
        const body = Buffer.concat(chunks);
        const decoded =
          request.headers['content-encoding'] === 'gzip'
            ? gunzipSync(body, { maxOutputLength: 8 * 1024 * 1024 })
            : body;
        record(exportSchema.validate(JSON.parse(decoded.toString('utf8'))));
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        errors.push(failure);
        response.writeHead(400).end(failure.message);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing metrics collector address');
  return {
    url: `http://127.0.0.1:${address.port}/v1/metrics`,
    samples,
    errors,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
