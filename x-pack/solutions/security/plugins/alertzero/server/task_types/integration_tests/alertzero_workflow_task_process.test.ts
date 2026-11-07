/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header, @typescript-eslint/no-non-null-assertion */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const HEADROOM_WORKFLOW_ID = 'triage-headroom-workflow';
const REPORT_WORKFLOW_ID = 'report-outcome-workflow';
const PACKAGE_WORKFLOW_ID = 'package-report-workflow';

/**
 * Runs `workflow:scheduled` workflows with AlertZero steps from the real bundle in a real task
 * process: the steps come from the `workflow-steps` contribution of AlertZero. The triage headroom
 * step reads Task Manager's tasks with the aggregation of the host and the live batches through
 * Kibana's API (the stub); the outcome step answers from what Kibana sent. The steps that read the
 * investigation conversation with Agent Builder are declined.
 */
describe('alertzero workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [HEADROOM_WORKFLOW_ID]: {
          steps: [
            {
              name: 'headroom',
              type: 'alertzero.triage.headroom',
              with: { batch_workflow_id: 'batch-workflow' },
            },
          ],
        },
        [REPORT_WORKFLOW_ID]: {
          steps: [
            {
              name: 'report',
              type: 'alertzero.reportWorkerOutcome',
              with: {},
            },
          ],
        },
        [PACKAGE_WORKFLOW_ID]: {
          steps: [{ name: 'package', type: 'hunt.packageReport', with: {} }],
        },
      },
      settings: {
        alertzero: {
          serviceAccountsEnabled: true,
          managedWorkflowsReady: true,
          telemetryOptedIn: false,
        },
      },
      // No batch of the workflow is running.
      kibanaHandler: () => ({ body: { results: [] } }),
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('reads the headroom with the aggregation of the host and the Kibana API of the run', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(HEADROOM_WORKFLOW_ID, onDispatchFailure);

    // Not declined: the step types are in the registry of the process.
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(HEADROOM_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const [step] = await harness.stepsOf(execution.id);
    expect(step).toEqual(expect.objectContaining({ stepId: 'headroom', status: 'completed' }));
    expect(step.output).toEqual(expect.objectContaining({ status: 'ok', in_flight: 0 }));
    // The live batches were read from Kibana with the credential of the run.
    expect(
      harness.kibanaRequests.some(
        ({ url, headers }) =>
          url?.includes('/api/workflows/workflow/batch-workflow/executions') &&
          String(headers.authorization).startsWith('ApiKey ')
      )
    ).toBe(true);
  });

  it('answers the outcome step from what Kibana sent: telemetry is opted out, so it skips', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(REPORT_WORKFLOW_ID, onDispatchFailure);

    expect(onDispatchFailure).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(REPORT_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    const [step] = await harness.stepsOf(execution.id);
    expect(step).toEqual(expect.objectContaining({ stepId: 'report', status: 'completed' }));
  });

  it('declines a workflow that packages a hunt report, writing nothing', async () => {
    const onDispatchFailure = jest.fn();
    await expect(harness.run(PACKAGE_WORKFLOW_ID, onDispatchFailure)).rejects.toThrow('422');

    expect(onDispatchFailure).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(PACKAGE_WORKFLOW_ID)).toHaveLength(0);
  });
});
