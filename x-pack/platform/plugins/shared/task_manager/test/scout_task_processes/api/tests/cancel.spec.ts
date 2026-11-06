/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { apiTest } from '@kbn/scout';
import { expect } from '@kbn/scout/api';
import {
  HEADERS,
  TEST_TIMEOUT_MS,
  INDEX_THRESHOLD,
  createEsQueryRule,
  deleteRule,
  getBundleProcesses,
  getStartedProcesses,
  readKibanaLog,
  isAlive,
  waitFor,
  uniqueName,
} from '../fixtures';

const TASK_TYPE = `alerting:${INDEX_THRESHOLD}`;

apiTest.describe(
  'Rules that time out in task processes',
  { tag: ['@local-stateful-classic'] },
  () => {
    let headers: Record<string, string>;
    const ruleIds: string[] = [];

    apiTest.beforeAll(async ({ samlAuth }) => {
      headers = { ...(await samlAuth.asInteractiveUser('admin')).cookieHeader, ...HEADERS };
    });

    apiTest.afterAll(async ({ apiClient }) => {
      await Promise.all(ruleIds.map((id) => deleteRule(apiClient, headers, id)));
    });

    // The config set gives the index threshold rule type a timeout of one second, which a process
    // that has to boot and query cannot meet
    apiTest('a run that is cancelled ends its task process', async ({ apiClient }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      const since = new Date().toISOString();
      const ruleId = await createEsQueryRule(apiClient, headers, {
        name: uniqueName('timeout-rule'),
        ruleTypeId: INDEX_THRESHOLD,
        interval: '5s',
      });
      ruleIds.push(ruleId);
      // Kibana cancels the task once it has expired, while its process is still working on it
      await waitFor(
        () =>
          readKibanaLog().some(
            (r) =>
              r.message.startsWith(`Cancelling task ${TASK_TYPE} "${ruleId}"`) &&
              Date.parse(r['@timestamp']) >= Date.parse(since)
          ),
        { message: 'Kibana to cancel the run', intervalMs: 500, timeoutMs: 120_000 }
      );
      const pids = getStartedProcesses(TASK_TYPE, since);
      expect(pids.length).toBeGreaterThan(0);
      // Stop the rule so no new process starts: none of those that started may remain
      await deleteRule(apiClient, headers, ruleId);
      ruleIds.pop();
      await waitFor(() => pids.every((pid) => !isAlive(pid)) && getBundleProcesses().length === 0, {
        message: `the task processes ${pids} to end`,
        timeoutMs: 60_000,
      });
      expect(getBundleProcesses()).toHaveLength(0);
    });
  }
);
