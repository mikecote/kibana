/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { apiTest } from '@kbn/scout';
import { expect } from '@kbn/scout/api';
import {
  ES_QUERY,
  TEST_TIMEOUT_MS,
  HEADERS,
  createConnector,
  createEsQueryRule,
  deleteConnector,
  deleteRule,
  getChildLines,
  getExecutions,
  getDispatchFailures,
  getStartedProcesses,
  readKibanaLog,
  type LogRecord,
  uniqueName,
  waitFor,
} from '../fixtures';

const TASK_TYPE = `alerting:${ES_QUERY}`;

const isServerLogConnectorOutput = (record: LogRecord, message: string): boolean =>
  record.message.includes(message) && record.labels?.task_type === undefined;

apiTest.describe(
  'Rules in task processes of a real Kibana',
  { tag: ['@local-stateful-classic'] },
  () => {
    let headers: Record<string, string>;
    const ruleIds: string[] = [];
    const connectorIds: string[] = [];

    apiTest.beforeAll(async ({ samlAuth }) => {
      headers = { ...(await samlAuth.asInteractiveUser('admin')).cookieHeader, ...HEADERS };
    });

    apiTest.afterAll(async ({ apiClient }) => {
      await Promise.all(ruleIds.map((id) => deleteRule(apiClient, headers, id)));
      await Promise.all(connectorIds.map((id) => deleteConnector(apiClient, headers, id)));
    });

    apiTest(
      'an es-query rule runs in a task process, its actions in Kibana, and its logs carry Kibana labels',
      async ({ apiClient, esClient }) => {
        apiTest.setTimeout(TEST_TIMEOUT_MS);
        const since = new Date().toISOString();
        const marker = uniqueName('server-log-marker');
        const connectorId = await createConnector(apiClient, headers, {
          name: uniqueName('server-log'),
          connector_type_id: '.server-log',
          config: {},
          secrets: {},
        });
        connectorIds.push(connectorId);
        const ruleId = await createEsQueryRule(apiClient, headers, {
          name: uniqueName('process-rule'),
          interval: '5s',
          actions: [
            {
              id: connectorId,
              group: 'query matched',
              params: { level: 'info', message: `${marker} {{rule.id}}` },
              frequency: { summary: false, throttle: null, notify_when: 'onActiveAlert' },
            },
          ],
        });
        ruleIds.push(ruleId);

        await waitFor(
          async () =>
            (await getExecutions(esClient, ruleId)).some((e) => e.event?.outcome === 'success'),
          { message: 'a successful execution in the event log', timeoutMs: 120_000 }
        );

        // It ran in a process: Kibana started one for the task type and logged the lines it wrote.
        expect(getStartedProcesses(TASK_TYPE, since).length).toBeGreaterThan(0);
        const childLines = getChildLines(TASK_TYPE, since);
        expect(childLines.length).toBeGreaterThan(0);
        // Logged with Kibana's layout (ECS records) and the labels of the run
        for (const line of childLines) {
          expect(typeof line.labels?.run_id).toBe('string');
          expect(typeof line.labels?.child_logger).toBe('string');
          expect(typeof line.log?.level).toBe('string');
        }
        // A healthy dispatch reports no process failures
        for (const reason of [
          'declined',
          'not_served',
          'capacity',
          'spawn_failed',
          'spawn_timeout',
          'unavailable',
        ]) {
          expect(getDispatchFailures(TASK_TYPE, reason, since)).toHaveLength(0);
        }

        // The alert document was written by the process
        await waitFor(
          async () => {
            const { hits } = await esClient.search({
              index: '.alerts-stack.alerts-default',
              query: { term: { 'kibana.alert.rule.uuid': ruleId } },
            });
            return hits.hits.length > 0;
          },
          { message: 'the alert document' }
        );

        // The action task ran in Kibana (it is not a task type module): the server log connector
        // wrote the message, from a logger that is not a child's
        // (the process logs the rendered message too, with its labels, when it enqueues the action)
        const isOutput = (record: LogRecord) =>
          isServerLogConnectorOutput(record, `${marker} ${ruleId}`);
        await waitFor(() => readKibanaLog().some(isOutput), {
          message: 'the server log connector output',
        });
        const output = readKibanaLog().find(isOutput);
        expect(output).toMatchObject({
          log: { logger: expect.stringMatching(/^plugins\.actions/) },
        });
      }
    );

    apiTest(
      'a connector with secrets is used by an action of a rule run in a task process',
      async ({ apiClient, esClient }) => {
        apiTest.setTimeout(TEST_TIMEOUT_MS);
        const received: Array<{ authorization?: string; body: string }> = [];
        const server = createServer((req, res) => {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            received.push({ authorization: req.headers.authorization, body });
            res.end('ok');
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const { port } = server.address() as AddressInfo;
          const connectorId = await createConnector(apiClient, headers, {
            name: uniqueName('webhook'),
            connector_type_id: '.webhook',
            config: {
              url: `http://127.0.0.1:${port}/hook`,
              method: 'post',
              hasAuth: true,
              authType: 'webhook-authentication-basic',
            },
            secrets: { user: 'scout-user', password: 'scout-secret' },
          });
          connectorIds.push(connectorId);
          const ruleId = await createEsQueryRule(apiClient, headers, {
            name: uniqueName('webhook-rule'),
            interval: '5s',
            actions: [
              {
                id: connectorId,
                group: 'query matched',
                params: { body: 'rule {{rule.id}}' },
                frequency: { summary: false, throttle: null, notify_when: 'onActiveAlert' },
              },
            ],
          });
          ruleIds.push(ruleId);
          await waitFor(() => received.some((r) => r.body === `rule ${ruleId}`), {
            message: 'the webhook request',
            timeoutMs: 150_000,
          });
          const request = received.find((r) => r.body === `rule ${ruleId}`)!;
          // The secrets were decrypted with the keys of Kibana, which the process shares to enqueue
          expect(request.authorization).toBe(
            `Basic ${Buffer.from('scout-user:scout-secret').toString('base64')}`
          );
          await waitFor(
            async () =>
              (await getExecutions(esClient, ruleId)).some((e) => e.event?.outcome === 'success'),
            { message: 'a successful execution in the event log' }
          );
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      }
    );
  }
);
