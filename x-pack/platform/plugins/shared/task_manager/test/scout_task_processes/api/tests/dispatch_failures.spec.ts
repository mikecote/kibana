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
  MAX_CONCURRENT_PROCESSES,
  createEsQueryRule,
  deleteRule,
  getExecutions,
  getDispatchFailures,
  getStartedProcesses,
  uniqueName,
  waitFor,
} from '../fixtures';

const TASK_TYPE = `alerting:${ES_QUERY}`;

apiTest.describe('Process capacity failures', { tag: ['@local-stateful-classic'] }, () => {
  let headers: Record<string, string>;
  const ruleIds: string[] = [];

  apiTest.beforeAll(async ({ samlAuth }) => {
    headers = { ...(await samlAuth.asInteractiveUser('admin')).cookieHeader, ...HEADERS };
  });

  apiTest.afterAll(async ({ apiClient }) => {
    await Promise.all(ruleIds.map((id) => deleteRule(apiClient, headers, id)));
  });

  apiTest(
    'with the process cap reached, extra runs retry in processes and every rule completes',
    async ({ apiClient, esClient }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      const since = new Date().toISOString();
      const count = MAX_CONCURRENT_PROCESSES * 3;
      const created = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          createEsQueryRule(apiClient, headers, {
            name: uniqueName(`capacity-rule-${i}`),
            interval: '5s',
          })
        )
      );
      ruleIds.push(...created);
      await waitFor(
        async () => {
          const runs = await Promise.all(created.map((id) => getExecutions(esClient, id)));
          return runs.every((r) => r.some((e) => e.event?.outcome === 'success'));
        },
        { message: 'every rule to complete a run', timeoutMs: 240_000 }
      );
      expect(getDispatchFailures(TASK_TYPE, 'capacity', since).length).toBeGreaterThan(0);
      // Process execution continued after capacity became available
      expect(getStartedProcesses(TASK_TYPE, since).length).toBeGreaterThan(0);
    }
  );
});
