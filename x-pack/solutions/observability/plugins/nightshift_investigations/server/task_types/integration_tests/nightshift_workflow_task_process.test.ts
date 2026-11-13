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

import { join } from 'path';
import { readFileSync } from 'fs';
import { NIGHTSHIFT_ENABLED_FLAG } from '@kbn/nightshift-shared';
import { NIGHTSHIFT_INVESTIGATION_WORKFLOW_ID } from '@kbn/workflows/managed';
import { NIGHTSHIFT_INVESTIGATION_AGENT_ID } from '../../agents/investigation';
import { REPO_ROOT } from '@kbn/repo-info';
import * as grpc from '@grpc/grpc-js';
import { config as sandboxConfig, getSandboxTaskProcessSettings } from '@kbn/sandbox-plugin/server';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';

const readCertificate = (name: string): Buffer =>
  readFileSync(join(REPO_ROOT, 'src/platform/packages/shared/kbn-dev-utils/certs', name));

const COMPOSE_WORKFLOW_ID = 'compose-hydrate-workflow';
const PREPARE_WORKFLOW_ID = 'decision-tree-prepare-workflow';
const SANDBOX_WORKFLOW_ID = 'obtain-sandbox-workflow';

/**
 * Runs `workflow:scheduled` workflows with Nightshift steps from the real bundle in a real task
 * process, including genuine native Sandbox gRPC allocation.
 */
describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Nightshift workflow steps in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

    let server: grpc.Server;
    let allocated: string[];
    beforeAll(async () => {
      allocated = [];
      server = new grpc.Server();
      const identity = (value: Buffer): Buffer => value;
      server.addService(
        {
          statFiles: {
            path: '/sandbox.SandboxService/StatFiles',
            requestStream: false,
            responseStream: false,
            requestSerialize: identity,
            requestDeserialize: identity,
            responseSerialize: identity,
            responseDeserialize: identity,
          },
        },
        {
          statFiles: (
            call: grpc.ServerUnaryCall<Buffer, Buffer>,
            callback: grpc.sendUnaryData<Buffer>
          ) => {
            allocated.push(String(call.metadata.get('x-conversation-id')[0]));
            expect(call.metadata.get('authorization')).toEqual(['ApiKey nightshift-worker-key']);
            callback(null, Buffer.from('0a100a0a2f776f726b737061636518012001', 'hex'));
          },
        }
      );
      const port = await new Promise<number>((resolve, reject) =>
        server.bindAsync(
          '127.0.0.1:0',
          grpc.ServerCredentials.createSsl(
            readCertificate('ca.crt'),
            [
              {
                private_key: readCertificate('kibana.key'),
                cert_chain: readCertificate('kibana.crt'),
              },
            ],
            true
          ),
          (error, bound) => (error ? reject(error) : resolve(bound))
        )
      );
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        featureFlags: { [NIGHTSHIFT_ENABLED_FLAG]: true },
        additionalContributions: {
          'workflow-steps': [
            join(
              REPO_ROOT,
              'x-pack/solutions/observability/plugins/significant_events/server/task_types/integration_tests/fixtures/nightshift_quota_steps_contribution.ts'
            ),
          ],
        },
        workflows: {
          [NIGHTSHIFT_INVESTIGATION_WORKFLOW_ID]: { steps: [] },
          'ensure-agent': {
            steps: [{ name: 'ensure', type: 'nightshift.ensureInvestigationAgent', with: {} }],
          },
          quota: { steps: [{ name: 'consume', type: 'test.nightshift.quota', with: {} }] },
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
                with: {
                  response: 'done',
                  agent_id: NIGHTSHIFT_INVESTIGATION_AGENT_ID,
                  tool_calls: [],
                },
              },
            ],
          },
          [SANDBOX_WORKFLOW_ID]: {
            steps: [
              {
                name: 'obtain',
                type: 'nightshift.obtainSandbox',
                with: { conversation_id: 'native-investigation' },
              },
            ],
          },
        },
        settings: {
          agenticInvestigationsRuntime: {
            securityEnabled: false,
            spacesEnabled: false,
            proposalsEnabled: true,
            escalationsEnabled: false,
          },
          agentBuilderRun: {
            config: {
              topSnippets: { numSnippets: 2, numWords: 750 },
              githubBaseUrl: 'https://github.com',
            },
            deploymentInfo: { environment: 'self_managed', airgapped: false, version: '9.6.0' },
            recommendedEndpoints: {},
          },
          sandboxRuntime: getSandboxTaskProcessSettings(
            sandboxConfig.schema.validate({
              enabled: true,
              host: 'localhost',
              port,
              api_key: 'nightshift-worker-key',
            }),
            {
              rootCertPem: readCertificate('ca.crt'),
              clientCertPem: readCertificate('relay.crt'),
              clientKeyPem: readCertificate('relay.key'),
            },
            false
          ),
          nightshiftInvestigations: {
            workflowsManagementAvailable: true,
            decisionTreesEnabled: false,
            sandboxAvailable: true,
            agentBuilderAvailable: true,
            agenticInvestigationsAvailable: true,
            proposalsAvailable: true,
            inferenceAvailable: true,
          },
        },
      });
    });

    afterAll(async () => {
      await harness?.stop();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server.tryShutdown((error) => (error ? reject(error) : resolve()))
        );
    });

    it('composes the hydrate notifications in the process', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(COMPOSE_WORKFLOW_ID, onDispatchFailure);

      // Not declined: the step types are in the registry of the process.
      expect(onDispatchFailure).not.toHaveBeenCalled();

      const [execution] = await harness.executionsOf(COMPOSE_WORKFLOW_ID);
      expect(execution).toEqual(
        expect.objectContaining({ status: 'completed', spaceId: 'default' })
      );
      const [step] = await harness.stepsOf(execution.id);
      expect(step).toEqual(expect.objectContaining({ stepId: 'compose', status: 'completed' }));
      expect(step.output.workflow_context['nightshift.semantic_memory.recall'].data).toEqual({
        recalled_ids: ['memory-1'],
      });
      expect(step.output.model_context).toContain('new file');
    });

    it('skips the decision tree preparation as Kibana does when the feature is off', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(PREPARE_WORKFLOW_ID, onDispatchFailure);

      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(PREPARE_WORKFLOW_ID);
      const [step] = await harness.stepsOf(execution.id);
      expect(step).toEqual(expect.objectContaining({ stepId: 'prepare', status: 'completed' }));
      expect(step.output).toEqual(expect.objectContaining({ skipped: true, tree_count: 0 }));
    });

    it('allocates its investigation workspace through native Sandbox without Main HTTP', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(SANDBOX_WORKFLOW_ID, onDispatchFailure);
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(SANDBOX_WORKFLOW_ID);
      expect({ status: execution.status, error: execution.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const [step] = await harness.stepsOf(execution.id);
      expect(step).toEqual(expect.objectContaining({ stepId: 'obtain', status: 'completed' }));
      expect(step.output).toEqual({
        sandbox_id: 'default__native-investigation',
        conversation_id: 'native-investigation',
      });
      expect(allocated).toEqual(['default__native-investigation']);
      expect(harness.kibanaRequests).toEqual([]);
    });
    it('installs the investigation agent using native stores and scoped registry readiness', async () => {
      const failed = jest.fn();
      await harness.run('ensure-agent', failed);
      expect(failed).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf('ensure-agent');
      expect({ status: execution.status, error: execution.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const [step] = await harness.stepsOf(execution.id);
      expect(step.output).toEqual({
        space_id: 'default',
        agent_id: NIGHTSHIFT_INVESTIGATION_AGENT_ID,
      });
      expect(harness.kibanaRequests).toEqual([]);
    });

    it('enforces the durable native investigation quota across independent runs', async () => {
      const failed = jest.fn();
      await harness.run('quota', failed);
      await harness.run('quota', failed);
      expect(failed).not.toHaveBeenCalled();
      const executions = await harness.executionsOf('quota');
      expect(executions).toHaveLength(2);
      const results = [];
      for (const execution of executions) {
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        results.push(step.output);
      }
      expect(results).toEqual(
        expect.arrayContaining([
          { allowed: true, count: 1 },
          { allowed: false, count: 1 },
        ])
      );
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
