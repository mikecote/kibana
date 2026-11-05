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

import { loggerMock } from '@kbn/logging-mocks';
import { kibanaPackageJson } from '@kbn/repo-info';
import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { AiIndexService } from '../../ai_indices/service';

const CREATE_WORKFLOW_ID = 'create-ki-workflow';
const FEEDBACK_WORKFLOW_ID = 'feedback-context-workflow';
const AI_INDEX_ID = 'my-ai-index';
const KI_INDEX = 'ai-index-idx-my-ki-index';

/**
 * Runs `workflow:scheduled` workflows with Context Engine steps from the real bundle in a real task
 * process: the steps come from the `workflow-steps` contribution of the plugin, which reads the
 * space's `contextEngine:enabled` setting, checks the write privilege of the run's user and writes
 * the knowledge indicator with the AI index service Kibana builds. A step that needs the global
 * feedback loop setting is declined.
 */
describe('context engine workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [CREATE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'create',
              type: 'context-engine.createKi',
              with: {
                ai_index_id: AI_INDEX_ID,
                ki: { type: 'detection', title: 'Failed logins' },
              },
            },
          ],
        },
        [FEEDBACK_WORKFLOW_ID]: {
          steps: [
            {
              name: 'feedback',
              type: 'context-engine.getFeedbackContext',
              with: { ai_index_id: AI_INDEX_ID },
            },
          ],
        },
      },
      seed: async ({ es, host }) => {
        // The AI index Kibana would have stored, over a plain index: the ones Kibana creates map
        // ELSER `semantic_text` fields, and the model is not deployed on the test cluster.
        await es.indices.create({
          index: KI_INDEX,
          settings: { number_of_replicas: 0 },
          mappings: { properties: { '@timestamp': { type: 'date' } } },
        });
        await new AiIndexService({ esClient: es as never, logger: loggerMock.create() }).put(
          AI_INDEX_ID,
          'default',
          { dest: { type: 'index', value: KI_INDEX }, automations: [], sources: [], traces: [] }
        );
        await host.savedObjects
          .getUnsafeInternalClient()
          .create(
            'config',
            { 'contextEngine:enabled': true, buildNum: 1 },
            { id: kibanaPackageJson.version, overwrite: true }
          );
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('writes the knowledge indicator in the process', async () => {
    const fallback = jest.fn();
    await harness.run(CREATE_WORKFLOW_ID, fallback as never);

    // Not declined: the step types are in the registry of the process.
    expect(fallback).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(CREATE_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const [step] = await harness.stepsOf(execution.id);
    expect(step).toEqual(expect.objectContaining({ stepId: 'create', status: 'completed' }));

    // The AI index was created in the space and the KI was written to its index, as in Kibana.
    await harness.es.indices.refresh({ index: KI_INDEX });
    const { hits } = await harness.es.search<Record<string, any>>({ index: KI_INDEX });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]._source).toEqual(
      expect.objectContaining({
        type: 'detection',
        title: 'Failed logins',
        governance: expect.objectContaining({
          provenance: expect.objectContaining({
            created_by: expect.objectContaining({ uri: `workflow://${CREATE_WORKFLOW_ID}` }),
          }),
        }),
      })
    );
  });

  it('declines a workflow that reads the feedback context, writing nothing', async () => {
    const fallback = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    await harness.run(FEEDBACK_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(FEEDBACK_WORKFLOW_ID)).toHaveLength(0);
  });
});
