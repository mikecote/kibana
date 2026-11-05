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

const WORKFLOW_ID = 'resolve-model-workflow';
const CONNECTOR_ID = 'llm-connector';

/**
 * Runs a `workflow:scheduled` workflow with the `significantEvents.resolveModel` step from the real
 * bundle in a real task process: the step comes from the `workflow-steps` contribution of
 * significant_events and reads the connector through the inference services built from the host and
 * the actions client of the run. The run is served by the process (not declined).
 */
describe('significant_events workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [WORKFLOW_ID]: {
          steps: [
            {
              name: 'model',
              type: 'significantEvents.resolveModel',
              with: { step: 'discovery', connector_id: CONNECTOR_ID },
            },
          ],
        },
      },
      seed: async ({ host }) => {
        // The connector Kibana would have saved: an LLM connector (the client encrypts its secrets).
        await host.savedObjects.getUnsafeInternalClient({ includedHiddenTypes: ['action'] }).create(
          'action',
          {
            name: 'stub llm',
            actionTypeId: '.gen-ai',
            isMissingSecrets: false,
            config: {
              apiProvider: 'OpenAI',
              apiUrl: 'http://127.0.0.1:9/v1/chat/completions',
              defaultModel: 'gpt-4',
            },
            secrets: { apiKey: 'test-key' },
          },
          { id: CONNECTOR_ID }
        );
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('resolves the model of the step in the process, from the connector Kibana saved', async () => {
    const fallback = jest.fn();
    await harness.run(WORKFLOW_ID, fallback as never);

    // Not declined: the step type is in the registry of the process.
    expect(fallback).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const steps = await harness.stepsOf(execution.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual(expect.objectContaining({ stepId: 'model', status: 'completed' }));
    expect(steps[0].output).toEqual({ connector_id: CONNECTOR_ID });
  });
});
