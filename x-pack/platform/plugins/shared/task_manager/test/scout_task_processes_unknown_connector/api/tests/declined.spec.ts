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
  createConnector,
  createEsQueryRule,
  deleteConnector,
  deleteRule,
  getExecutions,
  getDispatchFailures,
  uniqueName,
  waitFor,
} from '../../../scout_task_processes/api/fixtures';

const TASK_TYPE = `alerting:${ES_QUERY}`;

apiTest.describe('Process capability failures', { tag: ['@local-stateful-classic'] }, () => {
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
    'an incompatible bundle fails before executing the rule',
    async ({ apiClient, esClient }) => {
      apiTest.setTimeout(TEST_TIMEOUT_MS);
      const since = new Date().toISOString();
      // Registered by a test plugin, so no bundle knows it
      const connectorId = await createConnector(apiClient, headers, {
        name: uniqueName('unknown-type'),
        connector_type_id: 'test.not-enabled',
        config: {},
        secrets: {},
      });
      connectorIds.push(connectorId);
      const ruleId = await createEsQueryRule(apiClient, headers, {
        name: uniqueName('declined-rule'),
        interval: '5s',
        actions: [
          {
            id: connectorId,
            group: 'query matched',
            params: {},
            frequency: { summary: false, throttle: null, notify_when: 'onActiveAlert' },
          },
        ],
      });
      ruleIds.push(ruleId);
      await waitFor(async () => getDispatchFailures(TASK_TYPE, 'declined', since).length > 0, {
        message: 'an explicit process capability failure',
        timeoutMs: 120_000,
      });
      expect(await getExecutions(esClient, ruleId)).toHaveLength(0);
    }
  );
});
