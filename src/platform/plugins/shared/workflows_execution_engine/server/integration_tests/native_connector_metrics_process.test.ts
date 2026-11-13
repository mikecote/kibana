/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createNativeMetricsCollector } from '@kbn/task-manager-plugin/server/task_process/testing/native_metrics_collector';
import { createNativeMetricsInstrumentation } from '@kbn/task-manager-plugin/server/task_process/testing/native_metrics_instrumentation';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'native connector metrics in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let collector: Awaited<ReturnType<typeof createNativeMetricsCollector>>;
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let webhook: Server;
    const bodies: string[] = [];
    const webhookErrors: Error[] = [];
    beforeAll(async () => {
      bodies.length = 0;
      webhookErrors.length = 0;
      collector = await createNativeMetricsCollector();
      webhook = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('error', (error: Error) => webhookErrors.push(error));
        request.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 4096) request.destroy(new Error('Unexpected webhook body size'));
        });
        request.on('end', () => {
          bodies.push(body);
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
      });
      await new Promise<void>((resolve, reject) => {
        webhook.once('error', reject);
        webhook.listen(0, '127.0.0.1', resolve);
      });
      const address = webhook.address();
      if (!address || typeof address === 'string') throw new Error('Missing webhook address');
      const webhookUrl = `http://127.0.0.1:${address.port}`;
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        instrumentation: createNativeMetricsInstrumentation(collector.url),
        workflows: Object.fromEntries(
          ['first', 'second'].map((id) => [
            id,
            {
              steps: [
                {
                  name: 'notify',
                  type: 'webhook',
                  'connector-id': 'native-metrics-webhook',
                  with: { body: '{"native":"metrics"}' },
                },
              ],
            },
          ])
        ),
        seed: async ({ host }) => {
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: ['action'] })
            .create(
              'action',
              {
                name: 'native metrics webhook',
                actionTypeId: '.webhook',
                isMissingSecrets: false,
                config: { url: webhookUrl, method: 'post', hasAuth: false },
                secrets: { user: null, password: null },
              },
              { id: 'native-metrics-webhook' }
            );
        },
      });
    });
    afterAll(async () => {
      try {
        await harness?.stop();
      } finally {
        await collector?.stop();
        if (webhook) {
          webhook.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            webhook.close((error) => (error ? reject(error) : resolve()))
          );
        }
      }
    });
    it('exports exactly one native connector counter per real webhook execution', async () => {
      const failure = jest.fn();
      for (const [index, id] of ['first', 'second'].entries()) {
        await harness.run(id, failure);
        const [execution] = await harness.executionsOf(id);
        expect(execution.status).toBe('completed');
        expect(bodies).toEqual(Array(index + 1).fill('{"native":"metrics"}'));
        const samples = collector.samples.filter(
          ({ name }) => name === 'kibana.actions.connector.execute.count'
        );
        expect(samples.reduce((total, { value }) => total + value, 0)).toBe(index + 1);
        expect(samples.every(({ temporality }) => temporality === 1)).toBe(true);
        for (const sample of samples) {
          expect(sample.attributes).toEqual(
            expect.arrayContaining([
              { key: 'connector.type', value: { stringValue: '.webhook' } },
              { key: 'success', value: { boolValue: true } },
            ])
          );
        }
        expect(collector.errors).toEqual([]);
        expect(webhookErrors).toEqual([]);
        expect(failure).not.toHaveBeenCalled();
        expect(harness.kibanaRequests).toEqual([]);
      }
      const instances = new Set(
        collector.samples
          .filter(
            ({ name, value }) => name === 'kibana.actions.connector.execute.count' && value > 0
          )
          .map(({ instanceId }) => instanceId)
      );
      expect(instances.size).toBe(reuse ? 1 : 2);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 2);
    });
  }
);
