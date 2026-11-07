/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import {
  registerAgentBuilderProcessWorkflowDefinitions,
  registerAttachmentWorkflowSteps,
  registerConversationWorkflowSteps,
} from '../workflows';
import { RerankStepTypeId } from '../../common/step_types/rerank_step';
import { createAgentBuilderProcessServices } from './create_agent_builder_process_services';
import { AGENT_BUILDER_RUN_SETTINGS_ID } from '../run_services/run_settings';
import { contribution } from './workflow_steps_contribution';

jest.mock('./create_agent_builder_process_services', () => ({
  createAgentBuilderProcessServices: jest.fn(),
}));

/** What these steps need of Kibana: registries other plugins fill. A process does not register them. */
const DECLINED_STEPS = new Set<string>();

const registeredByKibana = () => {
  const steps: string[] = [];
  const triggers: string[] = [];
  const setup = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
    registerTriggerDefinition: (definition: { id: string }) => triggers.push(definition.id),
  } as unknown as WorkflowsExtensionsServerPluginSetup;
  registerAgentBuilderProcessWorkflowDefinitions(setup);
  const processSteps = [...steps];
  const deps = {} as never;
  registerConversationWorkflowSteps(setup, deps);
  registerAttachmentWorkflowSteps(setup, deps);
  steps.forEach((id) => {
    if (!processSteps.includes(id)) DECLINED_STEPS.add(id);
  });
  return { steps, triggers };
};

describe('agent_builder workflow-steps contribution', () => {
  it('registers every trigger and every step Kibana registers, except the declined ones', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    await contribution.register(registry, {
      host: {},
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
    });
    await registry.isReady();

    const kibana = registeredByKibana();
    expect(kibana.triggers.length).toBeGreaterThan(0);
    kibana.triggers.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
    kibana.steps.forEach((id) =>
      expect(registry.hasStepDefinition(id)).toBe(!DECLINED_STEPS.has(id))
    );
    expect(registry.hasStepDefinition(RerankStepTypeId)).toBe(true);
    // 10 conversation and attachment steps are declined; `runAgent` is registered in `plugin.ts` only.
    expect(DECLINED_STEPS.size).toBe(10);
  });
});

describe('agent_builder workflow-steps contribution with the services of a process', () => {
  const registrations = (ids: Record<string, string[]>) =>
    Object.fromEntries(
      [
        'tools',
        'agents',
        'agentTypes',
        'skills',
        'attachmentTypes',
        'conversationEvents',
        'conversationTemplates',
        'renderers',
        'hooks',
        'plugins',
        'aiIndexResolvers',
      ].map((kind) => [kind, ids[kind] ?? []])
    );
  const parityOf = (ids: Record<string, string[]>) =>
    Object.entries(registrations(ids)).map(([kind, list]) => ({
      kind: `agentBuilder.${kind}`,
      ids: list,
    }));

  const register = async ({
    kibana,
    process = { tools: ['a'] },
    deductiveRegistered = false,
    features = ['agent_builder'],
  }: {
    kibana?: Record<string, string[]>;
    process?: Record<string, string[]>;
    deductiveRegistered?: boolean;
    features?: string[];
  }) => {
    (createAgentBuilderProcessServices as jest.Mock).mockResolvedValue({
      serviceManager: {},
      registrations: { ids: () => registrations(process) },
      conversationEventBus: {
        onMetadataPatched: jest.fn(),
        onAttachmentEvents: jest.fn(),
        onConversationUpdated: jest.fn(),
      },
      conversationUpdatedOptIns: [],
      spaces: {},
      deductiveRegistered,
      inferenceFeatureIds: () => features,
    });
    const logger = loggerMock.create();
    const checks: Array<(step: { type: string; config: Record<string, unknown> }) => unknown> = [];
    const registry = createServerStepRegistry(logger);
    await contribution.register(registry, {
      host: { parity: kibana ? parityOf(kibana) : undefined, onRunEnd: jest.fn() },
      logger,
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: { [AGENT_BUILDER_RUN_SETTINGS_ID]: {} },
      services: { getActionsClientWithRequest: jest.fn(), emitEvent: jest.fn() } as never,
      registerRunCheck: (check) => checks.push(check),
    });
    const check = (type: string, config: Record<string, unknown> = {}) =>
      checks.map((fn) => fn({ type, config })).find(Boolean);
    return { registry, logger, check };
  };

  it('registers the steps that read the registries', async () => {
    const { registry } = await register({});
    for (const id of ['ai.agent', 'ai.conversation.create', 'ai.attachment.add']) {
      expect(registry.hasStepDefinition(id)).toBe(true);
    }
  });

  it('serves them when the process registered what Kibana did', async () => {
    const { check, logger } = await register({
      kibana: { tools: ['a'] },
      process: { tools: ['a'] },
    });
    expect(check('ai.agent')).toBeUndefined();
    expect(check('ai.conversation.create')).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('serves them when Kibana sent nothing to compare (a remote process)', async () => {
    const { check } = await register({ kibana: undefined, process: { tools: ['a'] } });
    expect(check('ai.agent')).toBeUndefined();
  });

  it('declines them when Kibana has an id the process lacks, naming it once, and no other step', async () => {
    const { check, logger } = await register({
      kibana: { tools: ['a', 'security.tool'] },
      process: { tools: ['a'] },
    });

    expect(check('ai.agent')).toContain('lacks tools [security.tool]');
    expect(check('ai.attachment.add')).toContain('lacks tools [security.tool]');
    expect(check('data.set')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('security.tool'));
  });

  it('declines them when the process has an id Kibana has not (a plugin disabled in this Kibana)', async () => {
    const { check } = await register({
      kibana: { skills: [] },
      process: { skills: ['search.only-in-process'] },
    });
    expect(check('ai.agent')).toContain('skills [search.only-in-process]');
  });

  it('resolves connector features at execution time, including templates and other plugins', async () => {
    const { check } = await register({ kibana: { tools: ['a'] }, process: { tools: ['a'] } });
    expect(check('ai.agent', { 'connector-id-by-feature': 'agent_builder' })).toBeUndefined();
    expect(check('ai.agent', { 'connector-id-by-feature': 'security_ai' })).toBeUndefined();
    expect(
      check('ai.agent', { 'connector-id-by-feature': '{{ inputs.feature }}' })
    ).toBeUndefined();
  });

  it('registers nothing that reads the registries when Kibana sent no settings for agent builder', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    await contribution.register(registry, {
      host: {},
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
      services: {} as never,
    });
    expect(registry.hasStepDefinition('ai.agent')).toBe(false);
  });
});
