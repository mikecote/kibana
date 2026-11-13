/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, httpServerMock, uiSettingsServiceMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { licensingMock } from '@kbn/licensing-plugin/server/mocks';
import { OBSERVABILITY_GET_LOGS_TOOL_ID } from '../tools/get_logs/constants';
import { contribution } from './agent_builder_contribution';
import { OBSERVABILITY_AGENT_BUILDER_TASK_PROCESS_SETTINGS_ID } from './observability_agent_builder_task_process_settings';

it('evaluates tool availability without constructing data access clients', async () => {
  const core = coreMock.createStart();
  const agentBuilder = agentBuilderMocks.createSetup();
  const getService = jest.fn();
  await contribution.register(agentBuilder, {
    host: {
      elasticsearch: core.elasticsearch.client,
      savedObjects: core.savedObjects,
      licensing: licensingMock.createStart(),
    },
    logger: loggingSystemMock.createLogger(),
    isServerless: false,
    kibanaVersion: '9.6.0',
    settings: {
      [OBSERVABILITY_AGENT_BUILDER_TASK_PROCESS_SETTINGS_ID]: {
        registrations: {
          toolIds: [OBSERVABILITY_GET_LOGS_TOOL_ID],
          attachmentTypeIds: [],
          skillIds: [],
        },
        dataProviders: [],
        mlEnabled: false,
        spacesEnabled: false,
      },
    },
    services: {
      registerRunCompletion: jest.fn(),
      getService,
      getCoreStart: jest.fn(),
      getActionsStart: jest.fn(),
      getActionsClientWithRequest: jest.fn(),
      getInferenceStart: jest.fn(),
      emitEvent: jest.fn(),
      getWorkflowsManagement: jest.fn(),
      getAgentBuilderStart: jest.fn(),
    },
    registerSmlType: jest.fn(),
  });
  const tool = agentBuilder.tools.register.mock.calls.find(
    ([registered]) => registered.id === OBSERVABILITY_GET_LOGS_TOOL_ID
  )?.[0];
  if (!tool?.availability) throw new Error('The native log tool has no availability handler');
  await expect(
    tool.availability.handler({
      request: httpServerMock.createKibanaRequest(),
      uiSettings: uiSettingsServiceMock.createClient(),
      spaceId: 'default',
    })
  ).resolves.toEqual({ status: 'available' });
  expect(getService).not.toHaveBeenCalled();
});
