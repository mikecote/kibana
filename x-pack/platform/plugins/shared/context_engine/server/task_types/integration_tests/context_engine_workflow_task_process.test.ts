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
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { AiIndexService } from '../../ai_indices/service';
import { installImprovementsIndexTemplate } from '../../improvements/storage';
import { IMPROVEMENTS_INDEX } from '../../../common/http_api/improvements';
import { CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID } from '../../../common/constants';

const CREATE_WORKFLOW_ID = 'create-ki-workflow';
const VERIFY_WORKFLOW_ID = 'verify-ki-workflow';
const CUSTOM_VERIFIER_ID = 'ki-verifier';
const TIMEOUT_VERIFIER_ID = 'ki-verifier-timeout';
const TIMEOUT_WORKFLOW_ID = 'verify-ki-timeout-workflow';
const FEEDBACK_WORKFLOW_ID = 'feedback-context-workflow';
const MANAGED_WORKFLOW_ID = 'managed-feedback-workflow';
const MANAGED_AI_INDEX_ID = 'managed-ai-index';
const AI_INDEX_ID = 'my-ai-index';
const KI_INDEX = 'ai-index-idx-my-ki-index';

/**
 * Runs `workflow:scheduled` workflows with Context Engine steps from the real bundle in a real task
 * process: the steps come from the `workflow-steps` contribution of the plugin, which reads the
 * space's `contextEngine:enabled` setting, checks the write privilege of the run's user and writes
 * the knowledge indicator with the AI index service Kibana builds, then read feedback and record
 * an improvement under the same global feedback-loop setting as Kibana.
 */
describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'context engine workflow steps in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        includeRunTask: true,
        settings: {
          contextEngineManagedAiIndices: {
            registrations: [
              {
                id: MANAGED_AI_INDEX_ID,
                properties: {
                  dest: { type: 'index', value: KI_INDEX },
                  automations: [],
                  sources: [],
                  traces: [],
                },
              },
            ],
          },
        },
        workflows: {
          [TIMEOUT_VERIFIER_ID]: {
            outputs: [{ name: 'passed', type: 'boolean' }],
            steps: [{ name: 'result', type: 'workflow.output', with: { passed: true } }],
          },
          [TIMEOUT_WORKFLOW_ID]: {
            steps: [
              {
                name: 'verify',
                type: 'context-engine.verifyKi',
                with: {
                  ki: { type: 'detection', title: 'Timed out indicator' },
                  verifiers: [{ workflow_id: TIMEOUT_VERIFIER_ID, timeout_sec: 1 }],
                },
              },
            ],
          },
          [CUSTOM_VERIFIER_ID]: {
            outputs: [
              { name: 'passed', type: 'boolean' },
              { name: 'reason', type: 'string' },
            ],
            steps: [
              {
                name: 'result',
                type: 'workflow.output',
                with: { passed: true, reason: 'Verified in the worker' },
              },
            ],
          },
          [VERIFY_WORKFLOW_ID]: {
            steps: [
              {
                name: 'verify',
                type: 'context-engine.verifyKi',
                with: {
                  ki: { type: 'detection', title: 'Custom verified indicator' },
                  verifiers: [{ workflow_id: CUSTOM_VERIFIER_ID, timeout_sec: 60 }],
                },
              },
            ],
          },
          [MANAGED_WORKFLOW_ID]: {
            steps: [
              {
                name: 'feedback',
                type: 'context-engine.getFeedbackContext',
                with: {
                  ai_index_id: `{{ '${MANAGED_AI_INDEX_ID}' }}`,
                },
              },
            ],
          },
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
              {
                name: 'record',
                type: 'context-engine.recordImprovements',
                with: {
                  ai_index_id: AI_INDEX_ID,
                  agent_run_id: '{{ execution.id }}',
                  signal_window: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' },
                  signal_spaces: ['default'],
                  improvements: [
                    {
                      action: 'add_ki',
                      title: 'Explain failed logins',
                      rationale: 'Include the recovery procedure',
                      target: { subject: 'failed-logins' },
                      payload: { ki: { type: 'document', title: 'Recovery procedure' } },
                      signal_ids: ['trace-1:span-1'],
                    },
                  ],
                },
              },
            ],
          },
        },
        seed: async ({ es, host }) => {
          await installImprovementsIndexTemplate({
            esClient: es as never,
            logger: loggerMock.create(),
          });
          // The AI index Kibana would have stored, over a plain index: the ones Kibana creates map
          // ELSER `semantic_text` fields, and the model is not deployed on the test cluster. Elasticsearch
          // ships an index template for `ai-index-*` that adds them to any index of that name, and the
          // first document written to such an index then waits ~30s for the inference endpoint (the
          // request times out): a template of a higher priority for this index keeps its mapping plain.
          await es.indices.putIndexTemplate({
            name: 'plain-ki-index',
            index_patterns: [KI_INDEX],
            priority: 100000,
            template: { settings: { number_of_replicas: 0 } },
          });
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
          await host.savedObjects
            .getUnsafeInternalClient()
            .create(
              'config-global',
              { [CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID]: true, buildNum: 1 },
              { id: kibanaPackageJson.version, overwrite: true }
            );
        },
      });
    });

    afterAll(async () => {
      await harness?.stop();
    });

    it('runs a custom verifier through the shared workflow management services', async () => {
      const onDispatchFailure = jest.fn();
      const parent = harness.run(VERIFY_WORKFLOW_ID, onDispatchFailure);
      const verifierTask = await harness.waitForRunTask(CUSTOM_VERIFIER_ID);
      await harness.runTask('workflow:run', verifierTask, onDispatchFailure);
      await parent;
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(VERIFY_WORKFLOW_ID);
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe('completed');
      const [step] = await harness.stepsOf(execution.id);
      expect(step.output).toMatchObject({
        passed: true,
        results: [{ verifier: `workflow:${CUSTOM_VERIFIER_ID}`, passed: true }],
      });
      const [verifier] = await harness.executionsOf(CUSTOM_VERIFIER_ID);
      expect(verifier.status).toBe('completed');
      expect(verifier.context.output).toMatchObject({
        passed: true,
        reason: 'Verified in the worker',
      });
    });

    it('cancels its verifier execution through the shared access-controlled API on timeout', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(TIMEOUT_WORKFLOW_ID, onDispatchFailure);
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(TIMEOUT_WORKFLOW_ID);
      expect(execution.status).toBe('completed');
      const [step] = await harness.stepsOf(execution.id);
      expect(step.output).toMatchObject({
        passed: false,
        results: [{ passed: false, reason: expect.stringContaining('timed out') }],
      });
      const [verifier] = await harness.executionsOf(TIMEOUT_VERIFIER_ID);
      expect(verifier.status).toBe('cancelled');
    });

    it('writes the knowledge indicator in the process', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(CREATE_WORKFLOW_ID, onDispatchFailure);

      // Not declined: the step types are in the registry of the process.
      expect(onDispatchFailure).not.toHaveBeenCalled();

      const [execution] = await harness.executionsOf(CREATE_WORKFLOW_ID);
      expect(execution).toEqual(
        expect.objectContaining({ status: 'completed', spaceId: 'default' })
      );
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

    it('reads feedback context and writes improvements in the process', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(FEEDBACK_WORKFLOW_ID, onDispatchFailure);

      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(FEEDBACK_WORKFLOW_ID);
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe('completed');
      const steps = await harness.stepsOf(execution.id);
      expect(steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stepId: 'feedback',
            status: 'completed',
            output: expect.objectContaining({ has_signals: false }),
          }),
          expect.objectContaining({
            stepId: 'record',
            status: 'completed',
            output: expect.objectContaining({ skipped: [] }),
          }),
        ])
      );
      await harness.es.indices.refresh({ index: IMPROVEMENTS_INDEX });
      const { hits } = await harness.es.search({ index: IMPROVEMENTS_INDEX });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]._source).toEqual(
        expect.objectContaining({
          ai_index_id: AI_INDEX_ID,
          space: 'default',
          title: 'Explain failed logins',
          provenance: expect.objectContaining({ agent_run_id: execution.id }),
        })
      );
    });

    it('bootstraps a managed AI index from the dispatch registry when its id is templated', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(MANAGED_WORKFLOW_ID, onDispatchFailure);
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(MANAGED_WORKFLOW_ID);
      expect(execution.error).toBeUndefined();
      expect(execution.status).toBe('completed');
      const index = await new AiIndexService({
        esClient: harness.es as never,
        logger: loggerMock.create(),
      }).get(MANAGED_AI_INDEX_ID, 'default');
      expect(index).toEqual(
        expect.objectContaining({ managed: true, dest: { type: 'index', value: KI_INDEX } })
      );
    });
    const expectedSpawnedWorkers = reuse ? 2 : 6;
    it('uses the configured worker lifetime', () => {
      expect(harness.getWorkerStats()).toMatchObject({
        spawned: expectedSpawnedWorkers,
        active: 0,
      });
    });
  }
);
