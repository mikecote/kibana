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

import { parse } from 'yaml';
import type { WorkflowYaml } from '@kbn/workflows';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import {
  ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
  ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
  ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
  getManagedWorkflowDefinition,
} from '@kbn/workflows/managed';
import { computeManagedDefinitionHash } from '@kbn/workflows-management-plugin/server/services/managed_workflow_status';
import { configSchema as alertingConfigSchema } from '@kbn/alerting-plugin/server/config';
import { config as ruleRegistryConfig } from '@kbn/rule-registry-plugin/server/config';
import {
  WORKFLOW_PROCESS_TEST_MODES,
  startWorkflowProcessHarness,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const RETRIEVAL_WORKFLOW_ID = 'attack-discovery-retrieval';
const PERSIST_WORKFLOW_ID = 'attack-discovery-persist';
const FEATURE_RUN_WORKFLOW_ID = 'attack-discovery-run-with-feature';
const ALERTS_INDEX = '.alerts-security.alerts-default';
const PERSISTED_INDEX = '.adhoc.alerts-security.attack.discovery.alerts-default';
const CONNECTOR_ID = 'discovery-model';
const DEFAULT_CONNECTOR_ID = 'default-discovery-model';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'discoveries in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        includeRunTask: true,
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
                with: {
                  alerts_context_count: 1,
                  anonymized_alerts: [],
                  api_config: { connector_id: CONNECTOR_ID, action_type_id: '.gen-ai' },
                  generation_uuid: 'generation-1',
                  attack_discoveries: [
                    {
                      alert_ids: ['alert-1'],
                      details_markdown: 'Attack details',
                      entity_summary_markdown: 'An affected host',
                      mitre_attack_tactics: ['Initial Access'],
                      summary_markdown: 'An attack',
                      title: 'Test Discovery',
                    },
                  ],
                },
              },
            ],
          },
          [FEATURE_RUN_WORKFLOW_ID]: {
            steps: [
              {
                name: 'run',
                type: 'security.attack-discovery.run',
                with: {
                  feature_id: 'attack_discovery',
                  size: 10,
                  mode: 'sync',
                  ground_truth_gate_enabled: false,
                  filter: { ids: { values: ['missing-alert'] } },
                },
              },
            ],
          },
        },
        settings: {
          discoveries: { connectorTimeout: 60000 },
          alerting: alertingConfigSchema.validate({}),
          ruleRegistry: ruleRegistryConfig.schema.validate({}),
          inferenceFeatures: {
            features: [
              {
                featureId: 'attack_discovery',
                featureName: 'Attack Discovery',
                featureDescription: 'Selects the model for attack discovery',
                taskType: 'chat_completion',
                recommendedEndpoints: [CONNECTOR_ID],
                ignoreGlobalDefault: true,
              },
            ],
          },
        },
        // The alert Kibana would have indexed.
        seed: async ({ es, host }) => {
          await es.index({
            index: '.kibana',
            id: `config:${host.server.version}`,
            refresh: 'wait_for',
            document: {
              type: 'config',
              config: {
                buildNum: 1,
                'securitySolution:enableAttackDiscoveryWorkflows': true,
                'genAiSettings:defaultAIConnector': DEFAULT_CONNECTOR_ID,
              },
              references: [],
            },
          });
          for (const connectorId of [CONNECTOR_ID, DEFAULT_CONNECTOR_ID]) {
            await host.savedObjects
              .getUnsafeInternalClient({ includedHiddenTypes: ['action'] })
              .create(
                'action',
                {
                  name: connectorId,
                  actionTypeId: '.gen-ai',
                  isMissingSecrets: false,
                  config: {
                    apiProvider: 'OpenAI',
                    apiUrl: 'http://127.0.0.1:1/v1/chat/completions',
                    defaultModel: 'gpt-4',
                  },
                  secrets: { apiKey: 'test-key' },
                },
                { id: connectorId }
              );
          }
          for (const id of [
            ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID,
            ATTACK_DISCOVERY_GENERATION_WORKFLOW_ID,
            ATTACK_DISCOVERY_VALIDATE_WORKFLOW_ID,
          ]) {
            const definition = getManagedWorkflowDefinition(id);
            if (!definition?.yaml) throw new Error(`Missing managed workflow ${id}`);
            await es.index({
              index: WORKFLOW_INDEX_NAME,
              id,
              refresh: 'wait_for',
              document: {
                name: id,
                enabled: true,
                valid: true,
                spaceId: 'default',
                yaml: definition.yaml,
                definition: parse(definition.yaml) as WorkflowYaml,
                managed: true,
                managedBy: 'discoveries',
                managedVersion: definition.version,
                definitionHash: computeManagedDefinitionHash(definition),
                createdBy: 'elastic',
                lastUpdatedBy: 'elastic',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            });
          }
          await es.index({
            index: '.kibana-elastic-ai-assistant-anonymization-fields-default',
            id: 'host',
            refresh: 'wait_for',
            document: { field: 'host.name', allowed: true, anonymized: true },
          });
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
      expect(execution).toEqual(
        expect.objectContaining({ status: 'completed', spaceId: 'default' })
      );
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

    it('persists discoveries and drops duplicates across separate workflow runs', async () => {
      for (let run = 0; run < 2; run++) {
        await harness.run(PERSIST_WORKFLOW_ID);
        const executions = await harness.executionsOf(PERSIST_WORKFLOW_ID);
        expect(executions).toHaveLength(run + 1);
        expect(executions.map(({ status }) => status)).toEqual(Array(run + 1).fill('completed'));
      }
      const executions = await harness.executionsOf(PERSIST_WORKFLOW_ID);
      expect(executions).toHaveLength(2);
      expect(executions.map(({ status, error }) => ({ status, error }))).toEqual([
        { status: 'completed', error: undefined },
        { status: 'completed', error: undefined },
      ]);
      const outputs = await Promise.all(
        executions.map(async ({ id }) => (await harness.stepsOf(id))[0].output)
      );
      expect(outputs.map(({ duplicates_dropped_count: count }) => count).sort()).toEqual([0, 1]);
      const persisted = await harness.es.search({ index: PERSISTED_INDEX });
      expect(persisted.hits.hits).toHaveLength(1);
    }, 120000);

    it('resolves the configured inference feature and runs the retrieval workflow in another worker', async () => {
      const failure = jest.fn();
      const parent = harness.run(FEATURE_RUN_WORKFLOW_ID, failure);
      const polling = new AbortController();
      const child = await Promise.race([
        harness.waitForRunTask(ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID, polling.signal),
        parent.then(async () => {
          const [execution] = await harness.executionsOf(FEATURE_RUN_WORKFLOW_ID);
          throw new Error(
            `Discovery run completed before retrieval: ${JSON.stringify({
              execution,
              steps: await harness.stepsOf(execution.id),
            })}`
          );
        }),
      ]).finally(() => polling.abort());
      await harness.runTask('workflow:run', child);
      await parent;
      expect(failure).not.toHaveBeenCalled();
      const [retrieval] = await harness.executionsOf(ATTACK_DISCOVERY_ALERT_RETRIEVAL_WORKFLOW_ID);
      expect(retrieval).toMatchObject({ status: 'completed' });
      const retrievalSteps = await harness.stepsOf(retrieval.id);
      expect(retrievalSteps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            output: expect.objectContaining({
              api_config: expect.objectContaining({ connector_id: CONNECTOR_ID }),
            }),
          }),
        ])
      );
      const [execution] = await harness.executionsOf(FEATURE_RUN_WORKFLOW_ID);
      expect(execution).toMatchObject({ status: 'completed' });
    }, 120000);
    it('uses the configured worker lifetime', () => {
      expect(harness.getWorkerStats()).toMatchObject({ spawned: reuse ? 2 : 5, active: 0 });
    });
  }
);
