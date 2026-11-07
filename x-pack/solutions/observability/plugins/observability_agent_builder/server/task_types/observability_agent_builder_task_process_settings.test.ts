/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { OBSERVABILITY_LOG_ATTACHMENT_TYPE_ID } from '../../common';
import { registerTools, OBSERVABILITY_TOOL_IDS } from '../tools/register_tools';
import { registerAttachments } from '../attachments/register_attachments';
import { registerSkills } from '../skills/register_skills';
import { ObservabilityAgentBuilderDataRegistry } from '../data_registry/data_registry';
import type {
  ObservabilityAgentBuilderRunCore,
  ObservabilityAgentBuilderRunSetupDependencies,
} from '../run_services/types';
import {
  createObservabilityAgentBuilderRegistrationState,
  getObservabilityAgentBuilderTaskProcessSettings,
} from './observability_agent_builder_task_process_settings';

describe('observability registration dispatch snapshots', () => {
  it('captures only successful native registrations and does not read execution services during registration', async () => {
    const logger = loggingSystemMock.createLogger();
    const registrations = createObservabilityAgentBuilderRegistrationState();
    const registry = new ObservabilityAgentBuilderDataRegistry(logger);
    const core: ObservabilityAgentBuilderRunCore = { getStartServices: jest.fn() };
    const contribution: AgentBuilderContribution = {
      register: async (agentBuilder) => {
        const nativeRegister = agentBuilder.tools.register;
        const plugins: ObservabilityAgentBuilderRunSetupDependencies = {
          agentBuilder: {
            ...agentBuilder,
            tools: {
              ...agentBuilder.tools,
              register: (tool) => {
                if (tool.id === OBSERVABILITY_TOOL_IDS[1]) throw new Error('registration rejected');
                nativeRegister(tool);
              },
            },
          },
          apmDataAccess: { getApmIndices: jest.fn(), getServices: jest.fn() },
          metricsDataAccess: { client: { getMetricIndices: jest.fn() } },
        };
        await expect(
          registerTools({
            core,
            plugins,
            logger,
            dataRegistry: registry,
            onRegistered: (id) => registrations.toolIds.add(id),
          })
        ).rejects.toThrow('registration rejected');
        await registerAttachments({
          core,
          plugins,
          logger,
          dataRegistry: registry,
          attachmentTypeIds: [OBSERVABILITY_LOG_ATTACHMENT_TYPE_ID],
          onRegistered: (id) => registrations.attachmentTypeIds.add(id),
        });
        registerSkills({ plugins, logger, onRegistered: (id) => registrations.skillIds.add(id) });
      },
    };
    const ids = await collectRegisteredIds({ contributions: [contribution], settings: {}, logger });
    const snapshot = getObservabilityAgentBuilderTaskProcessSettings({
      registrations,
      dataProviders: registry.getRegistrations(),
      mlEnabled: false,
      spacesEnabled: true,
    });
    expect(snapshot.registrations.toolIds).toEqual([OBSERVABILITY_TOOL_IDS[0]]);
    expect(snapshot.registrations.attachmentTypeIds).toEqual([
      OBSERVABILITY_LOG_ATTACHMENT_TYPE_ID,
    ]);
    expect(snapshot.registrations.skillIds).toHaveLength(1);
    expect(ids.tools).toEqual(expect.arrayContaining(snapshot.registrations.toolIds));
    expect(ids.attachmentTypes).toEqual(
      expect.arrayContaining(snapshot.registrations.attachmentTypeIds)
    );
    expect(ids.skills).toEqual(expect.arrayContaining(snapshot.registrations.skillIds));
    expect(core.getStartServices).not.toHaveBeenCalled();
    registrations.toolIds.add('later-tool');
    expect(snapshot.registrations.toolIds).toEqual([OBSERVABILITY_TOOL_IDS[0]]);
    expect(
      getObservabilityAgentBuilderTaskProcessSettings({
        registrations,
        dataProviders: [],
        mlEnabled: false,
        spacesEnabled: true,
      }).registrations.toolIds
    ).toEqual(['later-tool', OBSERVABILITY_TOOL_IDS[0]].sort());
  });
});
