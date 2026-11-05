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
import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { createProposalsStorageClient } from '../../storage/proposals_storage';

const READ_WORKFLOW_ID = 'read-proposal-workflow';
const CREATE_WORKFLOW_ID = 'create-proposal-workflow';
const PROPOSAL_ID = 'proposal-1';

/**
 * Runs `workflow:scheduled` workflows with proposal steps from the real bundle in a real task
 * process: the steps come from the `workflow-steps` contribution of proposals, read the proposals
 * index with the service Kibana builds and check the privileges of the run's user. A workflow that
 * creates a proposal (which attaches it to its conversation with Agent Builder) is declined.
 */
describe('proposals workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      workflows: {
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
              name: 'create',
              type: 'proposals.createProposal',
              with: {
                conversationId: 'conversation-1',
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
    const fallback = jest.fn();
    await harness.run(READ_WORKFLOW_ID, fallback as never);

    // Not declined: the step types are in the registry of the process.
    expect(fallback).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(READ_WORKFLOW_ID);
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    const steps = await harness.stepsOf(execution.id);
    const byId = Object.fromEntries(steps.map((step) => [step.stepId, step]));
    expect(byId.read).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(byId.read.output).toEqual(expect.objectContaining({ status: 'pending' }));
    expect(byId.privileges).toEqual(expect.objectContaining({ status: 'completed' }));
    expect(byId.privileges.output).toEqual({ canDecide: true });
  });

  it('declines a workflow that creates a proposal, writing nothing', async () => {
    const fallback = jest.fn(() => ({ run: async () => ({ state: {} }) }));
    await harness.run(CREATE_WORKFLOW_ID, fallback as never);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(CREATE_WORKFLOW_ID)).toHaveLength(0);
  });
});
