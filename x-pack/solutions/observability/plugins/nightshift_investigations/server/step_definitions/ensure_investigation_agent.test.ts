/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { installInvestigationAgent } from '../lib/install_investigation_agent';
import { NIGHTSHIFT_INVESTIGATION_AGENT_ID } from '../agents/investigation';
import { installDecisionTreeReinforcementAgent } from '../lib/install_decision_tree_reinforcement_agent';
import { NIGHTSHIFT_DECISION_TREE_REINFORCEMENT_AGENT_ID } from '../agents/decision_tree_reinforcement';
import { ensureInvestigationAgentStepDefinition } from './ensure_investigation_agent';

jest.mock('../lib/install_investigation_agent', () => ({
  installInvestigationAgent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/install_decision_tree_reinforcement_agent', () => ({
  installDecisionTreeReinforcementAgent: jest.fn().mockResolvedValue(undefined),
}));
describe('ensureInvestigationAgentStepDefinition', () => {
  const getAgent = jest.fn().mockResolvedValue({});
  const getRegistry = jest.fn().mockResolvedValue({ get: getAgent });
  const request = httpServerMock.createKibanaRequest({ spaceId: 'space-1' });
  const agentBuilder = { agents: { ensure: jest.fn(), getRegistry } } as never;

  beforeEach(() => {
    jest.clearAllMocks();
    getAgent.mockResolvedValue({});
  });

  const createContext = (input: Record<string, unknown>) =>
    ({
      input,
      rawInput: input,
      contextManager: {
        getContext: jest.fn().mockReturnValue({ workflow: { spaceId: 'space-1' } }),
        getFakeRequest: jest.fn(() => request),
        getScopedEsClient: jest.fn(),
        renderInputTemplate: jest.fn((val) => val),
      },
      logger: loggerMock.create(),
      abortSignal: new AbortController().signal,
      stepId: 'ensure_investigation_agent',
      stepType: 'nightshift.ensureInvestigationAgent',
    } as never);

  const availability = { cacheMode: 'space' as const, handler: jest.fn() };

  const run = (input: Record<string, unknown>) =>
    ensureInvestigationAgentStepDefinition({
      getAgentBuilder: () => agentBuilder,
      getAgentAvailability: () => availability,
    }).handler(createContext(input));

  // A step that omits `with` never reaches the input schema, so the default has to hold for `{}`.
  it('installs the Nightshift investigator when no agent is requested', async () => {
    const result = await run({});

    expect(installInvestigationAgent).toHaveBeenCalledWith({
      agentBuilder,
      spaceId: 'space-1',
      availability,
    });
    expect(getRegistry).toHaveBeenCalledWith({ request });
    expect(getAgent).toHaveBeenCalledWith(NIGHTSHIFT_INVESTIGATION_AGENT_ID);
    expect(result).toEqual({
      output: { space_id: 'space-1', agent_id: NIGHTSHIFT_INVESTIGATION_AGENT_ID },
    });
  });

  it('installs the Nightshift investigator when it is requested', async () => {
    const result = await run({ agent_id: NIGHTSHIFT_INVESTIGATION_AGENT_ID });

    expect(installInvestigationAgent).toHaveBeenCalledWith({
      agentBuilder,
      spaceId: 'space-1',
      availability,
    });
    expect(getRegistry).toHaveBeenCalledWith({ request });
    expect(getAgent).toHaveBeenCalledWith(NIGHTSHIFT_INVESTIGATION_AGENT_ID);
    expect(result).toEqual({
      output: { space_id: 'space-1', agent_id: NIGHTSHIFT_INVESTIGATION_AGENT_ID },
    });
  });

  it('installs the decision-tree reinforcement agent when it is requested', async () => {
    const result = await run({ agent_id: NIGHTSHIFT_DECISION_TREE_REINFORCEMENT_AGENT_ID });

    expect(installDecisionTreeReinforcementAgent).toHaveBeenCalledWith({
      agentBuilder,
      spaceId: 'space-1',
      availability,
    });
    expect(installInvestigationAgent).not.toHaveBeenCalled();
    expect(getRegistry).toHaveBeenCalledWith({ request });
    expect(getAgent).toHaveBeenCalledWith(NIGHTSHIFT_DECISION_TREE_REINFORCEMENT_AGENT_ID);
    expect(result).toEqual({
      output: { space_id: 'space-1', agent_id: NIGHTSHIFT_DECISION_TREE_REINFORCEMENT_AGENT_ID },
    });
  });
});
