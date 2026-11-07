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
import { ENTITY_ASSET_CRITICALITY_UPDATED_TRIGGER_ID } from '../../../common/workflow/triggers';
import { hashEuid } from '../../../common/domain/euid';
import { getLatestEntitiesIndexName } from '../../../common/domain/entity_index';

const WORKFLOW_ID = 'entity-criticality-workflow';
const SUBSCRIBER_WORKFLOW_ID = 'entity-criticality-subscriber';
const ENTITY_ID = 'host:my-host';

/**
 * Runs a `workflow:scheduled` workflow with the `entityStore.updateAssetCriticality` step from the
 * real bundle in a real task process: the step comes from the `workflow-steps` contribution of
 * entity_store. The run is served by the process (not declined), updates the entity in the latest
 * index, emits the asset criticality trigger event through the engine's runtime and recalculates the
 * risk score through the Kibana API.
 */
describe('entity_store workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
  const latestIndex = getLatestEntitiesIndexName('default');

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [WORKFLOW_ID]: {
          steps: [
            {
              name: 'criticality',
              type: 'entityStore.updateAssetCriticality',
              'recalculate-risk-score': true,
              with: {
                entity_type: 'host',
                entity_id: ENTITY_ID,
                criticality_level: 'high_impact',
              },
            },
          ],
        },
        // Subscribed to the event the step emits.
        [SUBSCRIBER_WORKFLOW_ID]: {
          triggers: [{ type: ENTITY_ASSET_CRITICALITY_UPDATED_TRIGGER_ID }],
          steps: [{ name: 'noop', type: 'console', with: { message: 'criticality changed' } }],
        },
      },
      kibanaHandler: () => ({ body: { ok: true } }),
    });
    await harness.es.indices.create({
      index: latestIndex,
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          entity: {
            properties: {
              id: { type: 'keyword' },
              EngineMetadata: { properties: { Type: { type: 'keyword' } } },
            },
          },
        },
      },
    });
    await harness.es.index({
      index: latestIndex,
      id: hashEuid(ENTITY_ID),
      refresh: 'wait_for',
      document: {
        '@timestamp': new Date().toISOString(),
        entity: { id: ENTITY_ID, EngineMetadata: { Type: 'host' } },
        host: { name: 'my-host' },
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('updates the entity, emits the trigger event and recalculates the risk score in the process', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(WORKFLOW_ID, onDispatchFailure);

    // Not declined: the step type is in the registry of the process.
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const steps = await harness.stepsOf(execution.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual(
      expect.objectContaining({ stepId: 'criticality', status: 'completed' })
    );
    expect(steps[0].output).toEqual(
      expect.objectContaining({
        success: true,
        message: `Successfully set criticality level to "high_impact" for entity ${ENTITY_ID} and triggered risk score recalculation`,
      })
    );

    // What Kibana would have written.
    const doc = await harness.es.get<{ asset?: { criticality?: string } }>({
      index: latestIndex,
      id: hashEuid(ENTITY_ID),
    });
    expect(doc._source?.asset?.criticality).toBe('high_impact');

    // The risk score recalculation went through the self client with the credential of the run.
    expect(harness.kibanaRequests).toHaveLength(1);
    expect(harness.kibanaRequests[0].method).toBe('POST');
    expect(harness.kibanaRequests[0].url).toBe('/internal/risk_score/calculation/entity_v2');
    expect(harness.kibanaRequests[0].headers.authorization).toBe(`ApiKey ${harness.apiKey}`);
    expect(JSON.parse(harness.kibanaRequests[0].body)).toEqual({
      identifier: ENTITY_ID,
      identifier_type: 'host',
      entity_id: ENTITY_ID,
    });

    // The event the update emitted reached the runtime of the engine, which scheduled the subscriber.
    await expect(
      (async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          await harness.es.indices.refresh({ index: '.kibana_task_manager' });
          const { hits } = await harness.es.search({
            index: '.kibana_task_manager',
            query: { match_all: {} },
            size: 20,
          });
          const subscribed = hits.hits.filter((hit) =>
            JSON.stringify(hit._source).includes(SUBSCRIBER_WORKFLOW_ID)
          );
          if (subscribed.length) return subscribed.length;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return 0;
      })()
    ).resolves.toBeGreaterThan(0);
  });
});
