/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

const WORKFLOW_ID = 'native-service-account-credentials';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Elasticsearch service-account credentials in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        useElasticsearchServiceAccount: true,
        workflows: {
          [WORKFLOW_ID]: {
            steps: [
              {
                name: 'user',
                type: 'elasticsearch.request',
                with: { request: { method: 'GET', path: '/_security/_authenticate' } },
              },
              { name: 'result', type: 'data.set', with: { value: 'native-service-account' } },
            ],
          },
        },
        seed: async ({ host }) => {
          const authenticated = await host.elasticsearch.asInternalUser.security.authenticate();
          expect(authenticated.username).toBe('elastic/kibana');
          expect(authenticated.authentication_type).toBe('token');
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('persists execution with the internal service account and keeps the workflow API key scoped', async () => {
      const dispatchFailure = jest.fn();
      await harness.run(WORKFLOW_ID, dispatchFailure);
      expect(dispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(WORKFLOW_ID);
      expect(execution.status).toBe('completed');
      const steps = await harness.stepsOf(execution.id);
      const authenticated = steps.find(({ stepId }) => stepId === 'user');
      expect(authenticated?.status).toBe('completed');
      expect(JSON.stringify(authenticated?.output)).toContain('"authentication_type":"api_key"');
      expect(JSON.stringify(steps)).toContain('native-service-account');
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
