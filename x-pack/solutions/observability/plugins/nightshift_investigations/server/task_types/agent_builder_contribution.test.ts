/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContributionContext } from '@kbn/agent-builder-server';
import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { contribution } from './agent_builder_contribution';
import type { NightshiftTaskProcessSettings } from './nightshift_task_process_settings';

const createContext = (
  snapshot?: NightshiftTaskProcessSettings
): AgentBuilderContributionContext => ({
  host: {},
  logger: loggerMock.create(),
  settings: snapshot ? { nightshiftInvestigations: snapshot } : {},
  kibanaVersion: '9.6.0',
  isServerless: false,
  registerSmlType: jest.fn(),
  services: {
    registerRunCompletion: jest.fn(),
    getService: jest.fn(),
    getCoreStart: jest.fn(),
    getActionsStart: jest.fn(),
    getActionsClientWithRequest: jest.fn(),
    getInferenceStart: jest.fn(),
    getWorkflowsManagement: jest.fn(),
    getAgentBuilderStart: jest.fn(),
    emitEvent: jest.fn(),
  },
});

const enabled = {
  workflowsManagementAvailable: true,
  decisionTreesEnabled: true,
  cortexEnabled: true,
  memoryEnabled: true,
  sandboxAvailable: true,
  agentBuilderAvailable: true,
} as const;

describe('native Nightshift Agent Builder contribution', () => {
  it('registers its complete tool, agent and attachment inventory without reading start services', async () => {
    const setup = agentBuilderMocks.createSetup();
    const context = createContext(enabled);
    await contribution.register(setup, context);
    expect(setup.tools.register.mock.calls.map(([tool]) => tool.id).sort()).toEqual([
      'nightshift_record_remediation',
      'nightshift_record_system_learning',
      'nightshift_record_tool_learning',
      'nightshift_sandbox_bash',
      'nightshift_sandbox_str_replace',
      'nightshift_sandbox_view_file',
      'nightshift_sandbox_write_file',
      'nightshift_submit_optimizer_result',
    ]);
    expect(setup.agents.registerType).toHaveBeenCalledTimes(2);
    expect(setup.attachments.registerType).toHaveBeenCalledTimes(1);
    expect(context.services.getService).not.toHaveBeenCalled();
    expect(context.services.getAgentBuilderStart).not.toHaveBeenCalled();
  });

  it('preserves Main registration gates when Sandbox and decision trees are disabled', async () => {
    const setup = agentBuilderMocks.createSetup();
    await contribution.register(
      setup,
      createContext({ ...enabled, sandboxAvailable: false, decisionTreesEnabled: false })
    );
    expect(setup.tools.register).not.toHaveBeenCalled();
    expect(setup.agents.registerType).toHaveBeenCalledTimes(1);
    expect(setup.attachments.registerType).toHaveBeenCalledTimes(1);
  });

  it('registers nothing when Nightshift or Agent Builder is absent from Main', async () => {
    for (const snapshot of [undefined, { ...enabled, agentBuilderAvailable: false }]) {
      const setup = agentBuilderMocks.createSetup();
      const context = createContext(snapshot);
      await contribution.register(setup, context);
      await contribution.registerAtStart?.(agentBuilderMocks.createStart(), context);
      expect(setup.tools.register).not.toHaveBeenCalled();
      expect(setup.agents.registerType).not.toHaveBeenCalled();
      expect(setup.attachments.registerType).not.toHaveBeenCalled();
      expect(context.services.getService).not.toHaveBeenCalled();
    }
  });
});
