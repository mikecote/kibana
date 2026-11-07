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

import { kibanaPackageJson } from '@kbn/repo-info';
import { PROPOSALS_INDEX_NAME } from '@kbn/proposals-common';
import { getAgentBuilderRunSettings } from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import { configSchema as agentBuilderConfigSchema } from '@kbn/agent-builder-plugin/server/config';
import { agentBuilderSpaceSettingsType } from '@kbn/agent-builder-plugin/server/saved_objects';
import { loggerMock } from '@kbn/logging-mocks';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { createProposalsStorageClient } from '../../storage/proposals_storage';

const READ_WORKFLOW_ID = 'read-proposal-workflow';
const CREATE_WORKFLOW_ID = 'create-proposal-workflow';
const PROPOSAL_ID = 'proposal-1';
const CREATED_PROPOSAL_ID = '035172d0-3806-4ea1-bccf-ecad7da4f91f';
const CLONE_WORKFLOW_ID = 'clone-proposal-workflow';

/**
 * Runs `workflow:scheduled` workflows with proposal steps from the real bundle in a real task
 * process: the steps come from the `workflow-steps` contribution of proposals, read the proposals
 * index with the service Kibana builds and check the privileges of the run's user. A workflow that
 * creates or clones a proposal writes both the proposal and its Agent Builder conversation card.
 */
describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'proposals workflow steps in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          proposalsAgentBuilder: {},
          agentBuilderRun: getAgentBuilderRunSettings({
            config: agentBuilderConfigSchema.validate({}, { dev: false }),
            env: {
              packageInfo: { version: kibanaPackageJson.version, buildFlavor: 'traditional' },
              airgapped: false,
            } as never,
            getSearchInferenceEndpoints: () => undefined,
          }),
        },
        savedObjectTypes: [agentBuilderSpaceSettingsType],
        workflows: {
          [CLONE_WORKFLOW_ID]: {
            steps: [
              {
                name: 'clone',
                type: 'proposals.cloneProposal',
                with: { proposalId: CREATED_PROPOSAL_ID, executionError: 'The action failed' },
              },
            ],
          },
          [READ_WORKFLOW_ID]: {
            steps: [
              { name: 'read', type: 'proposals.getProposal', with: { proposalId: PROPOSAL_ID } },
              {
                name: 'privileges',
                type: 'proposals.checkDecidePrivileges',
                with: { proposalId: PROPOSAL_ID, respondedBy: 'elastic' },
              },
            ],
          },
          [CREATE_WORKFLOW_ID]: {
            steps: [
              {
                name: 'conversation',
                type: 'ai.conversation.create',
                with: {
                  agent_id: 'elastic-ai-agent',
                  conversation_id: 'conversation-1',
                  title: 'Review proposals',
                },
              },
              {
                name: 'create',
                type: 'proposals.createProposal',
                with: {
                  proposalId: CREATED_PROPOSAL_ID,
                  conversationId: '{{ steps.conversation.output.conversation_id }}',
                  comment: 'Isolate the host',
                  origin: 'agent_builder',
                  category: 'containment',
                  impact: 'high',
                },
              },
            ],
          },
        },
        // The proposal Kibana would have stored.
        seed: async ({ es }) => {
          const now = new Date().toISOString();
          await createProposalsStorageClient({
            esClient: es as never,
            logger: loggerMock.create(),
          }).index({
            id: PROPOSAL_ID,
            refresh: true,
            document: {
              spaceId: 'default',
              conversationId: 'conversation-1',
              title: 'Isolate the host',
              comment: 'Isolate the host',
              status: 'pending',
              rootProposalId: PROPOSAL_ID,
              revision: 1,
              impact: 'high',
              confidence: 'medium',
              category: 'containment',
              origin: 'agent_builder',
              createdAt: now,
              createdBy: { username: 'elastic', fullName: null, email: null },
              ranks: { impact: 1, confidence: 1 },
            },
          } as never);
        },
      });
    });

    afterAll(async () => {
      await harness?.stop();
    });

    it('reads the proposal and checks the privileges in the process', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(READ_WORKFLOW_ID, onDispatchFailure);

      // Not declined: the step types are in the registry of the process.
      expect(onDispatchFailure).not.toHaveBeenCalled();

      const [execution] = await harness.executionsOf(READ_WORKFLOW_ID);
      expect(execution).toEqual(
        expect.objectContaining({ status: 'completed', spaceId: 'default' })
      );
      const steps = await harness.stepsOf(execution.id);
      const byId = Object.fromEntries(steps.map((step) => [step.stepId, step]));
      expect(byId.read).toEqual(expect.objectContaining({ status: 'completed' }));
      expect(byId.read.output).toEqual(expect.objectContaining({ status: 'pending' }));
      expect(byId.privileges).toEqual(expect.objectContaining({ status: 'completed' }));
      expect(byId.privileges.output).toEqual({ canDecide: true });
    });

    it('creates and clones proposals with persisted conversation attachments', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run(CREATE_WORKFLOW_ID, onDispatchFailure);
      const [createdExecution] = await harness.executionsOf(CREATE_WORKFLOW_ID);
      expect(createdExecution.error).toBeUndefined();
      expect(createdExecution.status).toBe('completed');
      const created = await harness.es.get<{ conversationId: string; status: string }>({
        index: PROPOSALS_INDEX_NAME,
        id: CREATED_PROPOSAL_ID,
      });
      expect(created._source).toMatchObject({
        conversationId: 'conversation-1',
        status: 'pending',
      });
      const conversation = await harness.es.get({
        index: '.chat-conversations',
        id: 'conversation-1',
      });
      expect(JSON.stringify(conversation._source)).toContain(CREATED_PROPOSAL_ID);

      await harness.es.update({
        index: PROPOSALS_INDEX_NAME,
        id: CREATED_PROPOSAL_ID,
        doc: { status: 'failed', decision: 'approved' },
        refresh: true,
      });
      await harness.run(CLONE_WORKFLOW_ID, onDispatchFailure);
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const [cloneExecution] = await harness.executionsOf(CLONE_WORKFLOW_ID);
      expect(cloneExecution.error).toBeUndefined();
      expect(cloneExecution.status).toBe('completed');
      const [step] = await harness.stepsOf(cloneExecution.id);
      const cloneId = String(step.output.proposalId);
      const clone = await harness.es.get({ index: PROPOSALS_INDEX_NAME, id: cloneId });
      expect(clone._source).toMatchObject({
        status: 'pending',
        conversationId: 'conversation-1',
        rootProposalId: CREATED_PROPOSAL_ID,
      });
      const original = await harness.es.get({
        index: PROPOSALS_INDEX_NAME,
        id: CREATED_PROPOSAL_ID,
      });
      expect(original._source).toMatchObject({ supersededBy: cloneId });
      const updatedConversation = await harness.es.get({
        index: '.chat-conversations',
        id: 'conversation-1',
      });
      expect(JSON.stringify(updatedConversation._source)).toContain(cloneId);
    });
    const expectedSpawnedWorkers = reuse ? 1 : 3;
    it('uses the configured worker lifetime', () => {
      expect(harness.getWorkerStats()).toMatchObject({
        spawned: expectedSpawnedWorkers,
        active: 0,
      });
    });
  }
);
