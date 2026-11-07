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

const PARENT_ID = 'system-connector-parent';
const CHILD_ID = 'system-connector-child';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'workflow system connector in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        includeRunTask: true,
        workflows: {
          [PARENT_ID]: {
            steps: [
              {
                name: 'schedule_child',
                type: 'workflows',
                'connector-id': 'system-connector-.workflows',
                with: {
                  subAction: 'run',
                  subActionParams: {
                    workflowId: CHILD_ID,
                    spaceId: 'default',
                    summaryMode: true,
                    inputs: { event: { alerts: [{ _id: 'alert-1', _index: 'alerts' }] } },
                  },
                },
              },
            ],
          },
          [CHILD_ID]: {
            steps: [
              {
                name: 'log',
                type: 'console',
                with: { message: 'scheduled by the system connector' },
              },
            ],
          },
        },
      });
    }, 240000);

    afterAll(async () => {
      await harness?.stop();
    });

    it('uses the real management service to schedule and execute a child workflow', async () => {
      for (let run = 0; run < 2; run++) {
        await harness.run(PARENT_ID);
        const parents = await harness.executionsOf(PARENT_ID);
        expect(parents).toHaveLength(run + 1);
        expect(parents).toEqual(
          expect.arrayContaining([expect.objectContaining({ status: 'completed' })])
        );
        expect(parents.map(({ status, error }) => ({ status, error }))).toEqual(
          Array.from({ length: run + 1 }, () => ({ status: 'completed', error: undefined }))
        );
      }
      const childTask = await harness.waitForRunTask(CHILD_ID);
      await harness.runTask('workflow:run', childTask);
      const children = await harness.executionsOf(CHILD_ID);
      expect(children).toHaveLength(2);
      expect(children.some(({ status }) => status === 'completed')).toBe(true);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 2 : 3);
      expect(harness.kibanaRequests).toEqual([]);
    }, 120000);
  }
);
