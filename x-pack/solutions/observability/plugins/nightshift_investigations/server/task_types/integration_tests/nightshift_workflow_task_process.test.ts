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

const COMPOSE_WORKFLOW_ID = 'compose-hydrate-workflow';
const PREPARE_WORKFLOW_ID = 'decision-tree-prepare-workflow';
const SANDBOX_WORKFLOW_ID = 'obtain-sandbox-workflow';

/**
 * Runs `workflow:scheduled` workflows with Nightshift steps from the real bundle in a real task
 * process: the steps come from the `workflow-steps` contribution of the plugin. The steps that need
 * the sandbox plugin or Agent Builder are declined.
 */
describe('nightshift investigations workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [COMPOSE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'compose',
              type: 'nightshift.composeHydrateNotifications',
              with: {
                writers: [
                  { directory: '/workspace/cortex', notification: 'new file', completed: true },
                ],
                recalled_ids: ['memory-1'],
              },
            },
          ],
        },
        [PREPARE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'prepare',
              type: 'nightshift.decisionTreePrepare',
              with: { response: 'done', agent_id: 'nightshift-investigation', tool_calls: [] },
            },
          ],
        },
        [SANDBOX_WORKFLOW_ID]: {
          steps: [{ name: 'obtain', type: 'nightshift.obtainSandbox', with: {} }],
        },
      },
      settings: {
        nightshiftInvestigations: {
          workflowsManagementAvailable: true,
          decisionTreesEnabled: false,
        },
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('composes the hydrate notifications in the process', async () => {
    const fallback = jest.fn();
    await harness.run(COMPOSE_WORKFLOW_ID, fallback as never);

    // Not declined: the step types are in the registry of the process.
    expect(fallback).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(COMPOSE_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const [step] = await harness.stepsOf(execution.id);
    expect(step).toEqual(expect.objectContaining({ stepId: 'compose', status: 'completed' }));
    expect(step.output.workflow_context['nightshift.semantic_memory.recall'].data).toEqual({
      recalled_ids: ['memory-1'],
    });
    expect(step.output.model_context).toContain('new file');
  });

  it('skips the decision tree preparation as Kibana does when the feature is off', async () => {
    const fallback = jest.fn();
    await harness.run(PREPARE_WORKFLOW_ID, fallback as never);

    expect(fallback).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(PREPARE_WORKFLOW_ID);
    const [step] = await harness.stepsOf(execution.id);
    expect(step).toEqual(expect.objectContaining({ stepId: 'prepare', status: 'completed' }));
    expect(step.output).toEqual(expect.objectContaining({ skipped: true, tree_count: 0 }));
  });

  it('declines a workflow that needs the sandbox, writing nothing', async () => {
    const fallback = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    await harness.run(SANDBOX_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(SANDBOX_WORKFLOW_ID)).toHaveLength(0);
  });
});
