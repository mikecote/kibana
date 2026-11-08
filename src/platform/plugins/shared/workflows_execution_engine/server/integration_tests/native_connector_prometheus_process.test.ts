/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { DataPointType } from '@opentelemetry/sdk-metrics';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createNativePrometheusInstrumentation } from '@kbn/task-manager-plugin/server/task_process/testing/native_metrics_instrumentation';
import { createNativePrometheusCollector } from '@kbn/task-manager-plugin/server/task_process/testing/native_prometheus_collector';
import type { WorkflowProcessHarnessOptions } from './workflow_process_harness';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'native connector Prometheus in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let collector: Awaited<ReturnType<typeof createNativePrometheusCollector>>;
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let webhook: Server;
    let options: WorkflowProcessHarnessOptions;
    const primaryOwner = 'f3e5fd65-90bc-48a9-938e-d7d528750197';
    const otherOwner = 'b4e23f4f-2c90-4dd3-8a2d-ef5b7cc23928';
    let unregisterGauges: (() => void) | undefined;
    const bodies: string[] = [];
    const webhookErrors: Error[] = [];
    beforeAll(async () => {
      bodies.length = 0;
      webhookErrors.length = 0;
      collector = await createNativePrometheusCollector();
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
      options = {
        serverUuid: primaryOwner,
        mode,
        reuse,
        instrumentation: createNativePrometheusInstrumentation(),
        onMetrics: (metrics) => collector.exporter.addMetrics(metrics),
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
      };
      harness = await startWorkflowProcessHarness(options);
      unregisterGauges = collector.exporter.registerGaugeSource(() =>
        harness.collectGaugeMetrics(primaryOwner)
      );
    });
    afterAll(async () => {
      try {
        unregisterGauges?.();
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
    it('scrapes exact native counters and histograms while collecting only live worker gauges', async () => {
      const failure = jest.fn();
      for (const [index, id] of ['first', 'second'].entries()) {
        await harness.run(id, failure);
        const [execution] = await harness.executionsOf(id);
        expect(execution.status).toBe('completed');
        expect(bodies).toEqual(Array(index + 1).fill('{"native":"metrics"}'));
        const scraped = await collector.scrape();
        const counters = scraped
          .split('\n')
          .filter((line) => line.startsWith('kibana_actions_connector_execute_count_total{'));
        expect(
          counters.reduce((total, line) => total + Number(line.slice(line.lastIndexOf(' ') + 1)), 0)
        ).toBe(index + 1);
        expect(
          counters.every(
            (line) => line.includes('connector_type=".webhook"') && line.includes('success="true"')
          )
        ).toBe(true);
        const histogram = scraped
          .split('\n')
          .filter((line) => line.startsWith('kibana_actions_connector_execute_duration_count{'));
        expect(
          histogram.reduce(
            (total, line) => total + Number(line.slice(line.lastIndexOf(' ') + 1)),
            0
          )
        ).toBe(index + 1);
        const headers = scraped
          .split('\n')
          .flatMap((line) => line.match(/^# (?:HELP|TYPE) \S+/)?.[0] ?? []);
        expect(new Set(headers).size).toBe(headers.length);
        expect(webhookErrors).toEqual([]);
        expect(failure).not.toHaveBeenCalled();
        expect(harness.kibanaRequests).toEqual([]);
      }
      const gauges = await harness.collectGaugeMetrics();
      expect(gauges).toHaveLength(reuse ? 1 : 0);
      expect(
        gauges.every(
          ({ resourceAttributes }) => typeof resourceAttributes['service.instance.id'] === 'string'
        )
      ).toBe(true);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 2);
      let otherCount = 0;
      options.serverUuid = otherOwner;
      options.onMetrics = (scopes) => {
        for (const scope of scopes)
          for (const metric of scope.metrics) {
            if (
              metric.dataPointType === DataPointType.SUM &&
              metric.descriptor.name === 'kibana.actions.connector.execute.count'
            ) {
              otherCount += metric.dataPoints.reduce((total, { value }) => total + value, 0);
            }
          }
      };
      await harness.run('first', failure);
      expect(otherCount).toBe(1);
      expect(await harness.collectGaugeMetrics(primaryOwner)).toEqual([]);
      const others = await harness.collectGaugeMetrics(otherOwner);
      expect(others).toHaveLength(reuse ? 1 : 0);
      const finalScrape = await collector.scrape();
      const finalCounters = finalScrape
        .split('\n')
        .filter((line) => line.startsWith('kibana_actions_connector_execute_count_total{'));
      expect(
        finalCounters.reduce(
          (total, line) => total + Number(line.slice(line.lastIndexOf(' ') + 1)),
          0
        )
      ).toBe(2);
      for (const other of others) {
        expect(finalScrape).not.toContain(String(other.resourceAttributes['service.instance.id']));
      }
      expect(failure).not.toHaveBeenCalled();
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
