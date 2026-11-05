/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const RERANK_WORKFLOW_ID = 'rerank-workflow';
const CONVERSATION_WORKFLOW_ID = 'conversation-workflow';

/**
 * Runs `workflow:scheduled` workflows from the real bundle in a real task process: the `rerank` step
 * comes from the `workflow-steps` contribution of Agent Builder. The conversation, attachment and
 * `runAgent` steps need registries that other plugins fill in Kibana, so a workflow that uses one is
 * declined.
 */
describe('agent_builder workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [RERANK_WORKFLOW_ID]: {
          steps: [
            {
              name: 'rerank',
              type: 'search.rerank',
              with: { rerank_text: 'hosts', data: [] },
            },
          ],
        },
        [CONVERSATION_WORKFLOW_ID]: {
          steps: [
            {
              name: 'create',
              type: 'ai.conversation.create',
              with: { agent_id: 'elastic-ai-agent', title: 'From a workflow' },
            },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('runs the rerank step in the process', async () => {
    const fallback = jest.fn();
    await harness.run(RERANK_WORKFLOW_ID, fallback as never);

    // Not declined: the step type is in the registry of the process.
    expect(fallback).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(RERANK_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
    const steps = await harness.stepsOf(execution.id);
    const rerank = steps.find((step) => step.stepId === 'rerank');
    expect(rerank).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(rerank?.output).toEqual([]);
  });

  it('declines a workflow that uses a conversation step, writing nothing', async () => {
    const fallback = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    await harness.run(CONVERSATION_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(CONVERSATION_WORKFLOW_ID)).toHaveLength(0);
  });
});
