/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createServer } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { lazySchema, z } from '@kbn/zod/v4';

const apmTransactionSchema = lazySchema(() =>
  z.object({
    id: z.string().max(64),
    trace_id: z.string().max(64),
    parent_id: z.string().max(64).optional(),
    name: z.string().max(4096),
    type: z.string().max(256),
  })
);
const resourceSchema = lazySchema(() =>
  z.object({
    attributes: z
      .array(
        z.object({
          key: z.string().max(1024),
          value: z.object({ stringValue: z.string().max(65536).optional() }),
        })
      )
      .max(10000),
  })
);
const spanSchema = lazySchema(() =>
  z.object({
    traceId: z.string().max(64),
    spanId: z.string().max(64),
    parentSpanId: z.string().max(64).optional(),
    name: z.string().max(4096),
  })
);
const otlpSchema = lazySchema(() =>
  z.object({
    resourceSpans: z
      .array(
        z.object({
          resource: resourceSchema,
          scopeSpans: z.array(z.object({ spans: z.array(spanSchema).max(10000) })).max(10000),
        })
      )
      .max(10000),
  })
);

interface TaskTraceCollector {
  url: string;
  apmTransactions: Array<z.output<typeof apmTransactionSchema>>;
  apmSpans: Array<z.output<typeof apmTransactionSchema>>;
  otelSpans: Array<{
    span: z.output<typeof spanSchema>;
    resource: z.output<typeof resourceSchema>;
  }>;
  stop: () => Promise<void>;
}

/** Receives actual native APM and OTLP HTTP exports on a local test listener. */
export const createTaskTraceCollector = async (): Promise<TaskTraceCollector> => {
  const apmTransactions: TaskTraceCollector['apmTransactions'] = [];
  const apmSpans: TaskTraceCollector['apmSpans'] = [];
  const otelSpans: TaskTraceCollector['otelSpans'] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks);
        const decoded =
          request.headers['content-encoding'] === 'gzip'
            ? gunzipSync(raw)
            : request.headers['content-encoding'] === 'deflate'
            ? inflateSync(raw)
            : raw;
        if (request.url === '/intake/v2/events') {
          for (const line of decoded.toString().split('\n').filter(Boolean)) {
            const event = z
              .object({
                transaction: apmTransactionSchema.optional(),
                span: apmTransactionSchema.optional(),
              })
              .parse(JSON.parse(line));
            if (event.transaction) apmTransactions.push(event.transaction);
            if (event.span) apmSpans.push(event.span);
          }
          response.writeHead(202).end();
          return;
        }
        if (request.url === '/v1/traces') {
          const data = otlpSchema.parse(JSON.parse(decoded.toString()));
          for (const { resource, scopeSpans } of data.resourceSpans) {
            for (const scope of scopeSpans) {
              for (const span of scope.spans) otelSpans.push({ span, resource });
            }
          }
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"8.17.0"}');
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Trace collector has no listening address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    apmTransactions,
    apmSpans,
    otelSpans,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};
