/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SYSTEM_SECURITY_WORKER_FLOOR_ALERT_TRIAGE_ID } from '@kbn/alertzero-common';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { extendWorkflowTestMappings } from './fixtures/workflow_test_mappings';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native AlertZero outcome reporting in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        workflows: {
          outcome: {
            steps: [
              {
                name: 'outcome',
                type: 'alertzero.reportWorkerOutcome',
                with: { event: 'worker_run_completed', run_outcome: 'empty_nothing_pending' },
              },
            ],
          },
        },
        settings: {
          alertzero: {
            serviceAccountsEnabled: true,
            managedWorkflowsReady: true,
            searchInferenceEndpointsAvailable: false,
            telemetryOptedIn: true,
          },
          workflowsManagementRuntime: { available: true, managedWorkflowPluginIds: ['alertzero'] },
        },
        seed: async ({ es }) => {
          await extendWorkflowTestMappings(es);
          await es.update({
            index: WORKFLOW_INDEX_NAME,
            id: 'outcome',
            refresh: 'wait_for',
            doc: {
              managed: true,
              managedBy: 'alertzero',
              originManagedWorkflowId: SYSTEM_SECURITY_WORKER_FLOOR_ALERT_TRIAGE_ID,
              managedVersion: 1,
              lifecycle: 'static',
            },
          });
        },
      });
    }, 300000);
    afterAll(async () => harness?.stop());

    it('checks native managed ownership and persisted execution lineage before accepting telemetry', async () => {
      const seen = new Set<string>();
      const failure = jest.fn();
      for (const [owner, reported] of [
        ['alertzero', true],
        ['another-owner', false],
        ['alertzero', true],
      ] as const) {
        await harness.es.update({
          index: WORKFLOW_INDEX_NAME,
          id: 'outcome',
          refresh: 'wait_for',
          doc: { managedBy: owner },
        });
        await harness.run('outcome', failure);
        const execution = (await harness.executionsOf('outcome')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No outcome execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const steps = await harness.stepsOf(execution.id);
        expect(steps.find(({ stepId }) => stepId === 'outcome')).toMatchObject({
          status: 'completed',
          output: { reported },
        });
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    });
  }
);
