/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { registerAgentBuilderTools } from './register_tools';
import {
  SIGNIFICANT_EVENTS_EVENT_CREATE_TOOL_ID,
  SIGNIFICANT_EVENTS_EVENT_STATUS_UPDATE_TOOL_ID,
  SIGNIFICANT_EVENTS_SEARCH_EVENTS_TOOL_ID,
  SIGNIFICANT_EVENTS_KNOWLEDGE_INDICATORS_SEARCH_TOOL_ID,
  SIGNIFICANT_EVENTS_FEATURE_SIMILARITY_SEARCH_TOOL_ID,
} from './register_tools';
import { createMockGetScopedClients } from '../utils/test_helpers';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import type { EbtTelemetryClient } from '../../lib/telemetry/ebt';

const createMockServer = () => ({ security: securityMock.createStart() });

describe('registerAgentBuilderTools', () => {
  const telemetry = {
    trackAgentBuilderKnowledgeIndicatorCreated: jest.fn(),
  } as unknown as EbtTelemetryClient;

  it('registers all expected tools', () => {
    const agentBuilder = agentBuilderMocks.createSetup();
    const { getScopedClients } = createMockGetScopedClients();

    registerAgentBuilderTools({
      assertAccess: jest.fn(),
      agentBuilder,
      getScopedClients,
      server: createMockServer(),
      logger: loggerMock.create(),
      telemetry,
    });

    const registeredIds = agentBuilder.tools.register.mock.calls.map((call) => call[0].id);

    expect(registeredIds).toContain(SIGNIFICANT_EVENTS_KNOWLEDGE_INDICATORS_SEARCH_TOOL_ID);
    expect(registeredIds).toContain(SIGNIFICANT_EVENTS_FEATURE_SIMILARITY_SEARCH_TOOL_ID);
    expect(registeredIds).toContain(SIGNIFICANT_EVENTS_SEARCH_EVENTS_TOOL_ID);
    expect(registeredIds).toContain(SIGNIFICANT_EVENTS_EVENT_CREATE_TOOL_ID);
    expect(registeredIds).toContain(SIGNIFICANT_EVENTS_EVENT_STATUS_UPDATE_TOOL_ID);
  });

  it('registers tools with non-empty descriptions and schemas', () => {
    const agentBuilder = agentBuilderMocks.createSetup();
    const { getScopedClients } = createMockGetScopedClients();

    registerAgentBuilderTools({
      assertAccess: jest.fn(),
      agentBuilder,
      getScopedClients,
      server: createMockServer(),
      logger: loggerMock.create(),
      telemetry,
    });

    for (const [tool] of agentBuilder.tools.register.mock.calls) {
      expect(tool.description).toBeTruthy();
      expect(tool).toHaveProperty('schema');
      expect((tool as { schema: unknown }).schema).toBeDefined();
    }
  });

  it('registers precisely the dispatched tool set and reports successful registrations', () => {
    const agentBuilder = agentBuilderMocks.createSetup();
    const onRegistered = jest.fn();
    registerAgentBuilderTools({
      agentBuilder,
      getScopedClients: jest.fn(),
      server: createMockServer(),
      assertAccess: jest.fn(),
      logger: loggerMock.create(),
      telemetry,
      toolIds: [SIGNIFICANT_EVENTS_SEARCH_EVENTS_TOOL_ID],
      onRegistered,
    });
    expect(agentBuilder.tools.register.mock.calls.map(([tool]) => tool.id)).toEqual([
      SIGNIFICANT_EVENTS_SEARCH_EVENTS_TOOL_ID,
    ]);
    expect(onRegistered.mock.calls).toEqual([[SIGNIFICANT_EVENTS_SEARCH_EVENTS_TOOL_ID]]);
  });

  it('does not advertise a failed native registration or any tool after it', () => {
    const agentBuilder = agentBuilderMocks.createSetup();
    const onRegistered = jest.fn();
    agentBuilder.tools.register
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Registry failed');
      });
    expect(() =>
      registerAgentBuilderTools({
        agentBuilder,
        getScopedClients: jest.fn(),
        server: createMockServer(),
        assertAccess: jest.fn(),
        logger: loggerMock.create(),
        telemetry,
        onRegistered,
      })
    ).toThrow('Registry failed');
    expect(onRegistered.mock.calls).toEqual([
      [SIGNIFICANT_EVENTS_KNOWLEDGE_INDICATORS_SEARCH_TOOL_ID],
    ]);
  });

  it('does not register any tools when agentBuilder is falsy', () => {
    const agentBuilder = agentBuilderMocks.createSetup();
    const { getScopedClients } = createMockGetScopedClients();

    registerAgentBuilderTools({
      assertAccess: jest.fn(),
      agentBuilder: undefined!,
      getScopedClients,
      server: createMockServer(),
      logger: loggerMock.create(),
      telemetry,
    });

    expect(agentBuilder.tools.register).not.toHaveBeenCalled();
  });
});
