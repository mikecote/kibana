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
import { contribution } from './workflow_steps_contribution';

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
