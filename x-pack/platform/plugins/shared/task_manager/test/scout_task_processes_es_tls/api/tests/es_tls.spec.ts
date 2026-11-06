/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { apiTest } from '@kbn/scout';
import { expect } from '@kbn/scout/api';
import {
  ES_QUERY,
  TEST_TIMEOUT_MS,
  HEADERS,
  createEsQueryRule,
  deleteRule,
  getChildLines,
  getExecutions,
  getFallbacks,
  uniqueName,
  waitFor,
} from '../../../scout_task_processes/api/fixtures';

const TASK_TYPE = `alerting:${ES_QUERY}`;

apiTest.describe(
  'Rules in task processes with Elasticsearch over TLS',
  { tag: ['@local-stateful-classic'] },
  () => {
    let headers: Record<string, string>;
    let ruleId = '';

    apiTest.beforeAll(async ({ samlAuth }) => {
      headers = { ...(await samlAuth.asInteractiveUser('admin')).cookieHeader, ...HEADERS };
    });

    apiTest.afterAll(async ({ apiClient }) => {
      if (ruleId) await deleteRule(apiClient, headers, ruleId);
    });

    apiTest(
      'a rule runs in a task process that reaches Elasticsearch as kibana_system over TLS',
      async ({ apiClient, esClient }) => {
        apiTest.setTimeout(TEST_TIMEOUT_MS);
        const since = new Date().toISOString();
        ruleId = await createEsQueryRule(apiClient, headers, {
          name: uniqueName('tls-rule'),
          interval: '5s',
        });
        await waitFor(
          async () =>
            (await getExecutions(esClient, ruleId!)).some((e) => e.event?.outcome === 'success'),
          { message: 'a successful execution', timeoutMs: 120_000 }
        );
        expect(getChildLines(TASK_TYPE, since).length).toBeGreaterThan(0);
        for (const reason of [
          'declined',
          'not_served',
          'spawn_failed',
          'spawn_timeout',
          'unavailable',
        ]) {
          expect(getFallbacks(TASK_TYPE, reason, since)).toHaveLength(0);
        }
      }
    );
  }
);
