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

const RETRIEVAL_WORKFLOW_ID = 'attack-discovery-retrieval';
const PERSIST_WORKFLOW_ID = 'attack-discovery-persist';
const FEATURE_RUN_WORKFLOW_ID = 'attack-discovery-run-with-feature';
const ALERTS_INDEX = 'test-attack-discovery-alerts';

/**
 * Runs `workflow:scheduled` workflows with attack discovery steps from the real bundle in a real
 * task process: the steps come from the `workflow-steps` contribution of discoveries, which retrieve
 * and anonymize the alerts with the scoped Elasticsearch client of the run. The persist step (which needs the rule registry's data client) and a run step that
 * names an inference feature are declined.
 */
describe('discoveries workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
        [RETRIEVAL_WORKFLOW_ID]: {
          steps: [
            {
              name: 'retrieve',
              type: 'security.attack-discovery.defaultAlertRetrieval',
              with: {
                alerts_index_pattern: ALERTS_INDEX,
                anonymization_fields: [
                  { id: 'host', field: 'host.name', allowed: true, anonymized: true },
                ],
                api_config: { connector_id: '', action_type_id: '.gen-ai' },
                filter: { ids: { values: ['alert-1'] } },
                size: 10,
              },
            },
          ],
        },
        [PERSIST_WORKFLOW_ID]: {
          steps: [
            {
              name: 'persist',
              type: 'security.attack-discovery.persistDiscoveries',
              with: {},
            },
          ],
        },
        [FEATURE_RUN_WORKFLOW_ID]: {
          steps: [
            {
              name: 'run',
              type: 'security.attack-discovery.run',
              with: { feature_id: 'attack_discovery', size: 10 },
            },
          ],
        },
      },
      settings: { discoveries: { connectorTimeout: 60000 } },
      // The alert Kibana would have indexed.
      seed: async ({ es }) => {
        await es.indices.create({
          index: ALERTS_INDEX,
          mappings: {
            properties: {
              '@timestamp': { type: 'date' },
              'host.name': { type: 'keyword' },
              'kibana.alert.risk_score': { type: 'float' },
              'kibana.alert.workflow_status': { type: 'keyword' },
            },
          },
        });
        await es.index({
          index: ALERTS_INDEX,
          id: 'alert-1',
          refresh: 'wait_for',
          document: {
            '@timestamp': new Date().toISOString(),
            'host.name': 'host-1',
            'kibana.alert.workflow_status': 'open',
            'kibana.alert.risk_score': 50,
          },
        });
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('retrieves and anonymizes the alerts in the process', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(RETRIEVAL_WORKFLOW_ID, onDispatchFailure);

    // Not declined: the step types are in the registry of the process.
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(RETRIEVAL_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const [step] = await harness.stepsOf(execution.id);
    expect(step).toEqual(expect.objectContaining({ stepId: 'retrieve', status: 'completed' }));
    expect(step.output).toEqual(
      expect.objectContaining({
        alerts_context_count: 1,
        api_config: { connector_id: '', action_type_id: '.gen-ai' },
      })
    );
    // The host name was anonymized: the alert the model sees does not carry it.
    expect(JSON.stringify(step.output.alerts)).not.toContain('host-1');
  });

  it.each([
    ['persists discoveries (rule registry data client)', PERSIST_WORKFLOW_ID],
    ['runs with an inference feature id', FEATURE_RUN_WORKFLOW_ID],
  ])('declines a workflow that %s, writing nothing', async (_name, workflowId) => {
    const onDispatchFailure = jest.fn();
    await expect(harness.run(workflowId, onDispatchFailure)).rejects.toThrow('422');

    expect(onDispatchFailure).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(workflowId)).toHaveLength(0);
  });
});
