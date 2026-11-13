/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import { TASK_MANAGER_CLAIM_NUDGE_INDEX } from '@kbn/task-manager-plugin/server/constants';
import { z } from '@kbn/zod/v4';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

const resultSchema = z.object({
  blockedFirst: z.literal(true),
  forced: z.literal(true),
  blockedThird: z.literal(true),
  apiKeyId: z.string(),
});
const outputSchema = z.union([
  z.object({ output: resultSchema }).transform(({ output }) => output),
  resultSchema,
]);

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native active dispatch pool in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let reads = 0;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        claimNudge: true,
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/task_scheduling_contribution.ts')],
        },
        getCurrentTasksInPool: () => {
          reads++;
          return reads % 3 === 2
            ? []
            : ['pool-target-first::peer-execution', 'pool-target-second::peer-execution'];
        },
        workflows: Object.fromEntries(
          ['first', 'second'].map((id) => [
            id,
            {
              steps: [
                {
                  name: 'coordinate',
                  type: 'test.task_scheduling.native_pool',
                  with: { taskId: `pool-target-${id}` },
                },
              ],
            },
          ])
        ),
      });
    });
    afterAll(async () => harness?.stop());

    it('reads changed peer executions on each force check and finishes native claim notifications', async () => {
      const failure = jest.fn();
      for (const id of ['first', 'second']) {
        await harness.run(id, failure);
        const [execution] = await harness.executionsOf(id);
        expect(execution.status).toBe('completed');
        const [step] = await harness.stepsOf(execution.id);
        const result = outputSchema.parse(step.output);
        const raw = await harness.es.get<{ task: { apiKey: string; status: string } }>({
          index: '.kibana_task_manager',
          id: `task:pool-target-${id}`,
        });
        expect(raw._source?.task.status).toBe('running');
        expect(Buffer.from(raw._source?.task.apiKey ?? '', 'base64').toString()).not.toContain(
          result.apiKeyId
        );
      }
      expect(reads).toBe(6);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 2);
      const nudge = await harness.es.get<{ nonce: string }>({
        index: TASK_MANAGER_CLAIM_NUDGE_INDEX,
        id: 'global',
      });
      expect(nudge._source?.nonce).toEqual(expect.any(String));
      expect(nudge._seq_no).toBeGreaterThanOrEqual(1);
      expect(failure).not.toHaveBeenCalled();
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
