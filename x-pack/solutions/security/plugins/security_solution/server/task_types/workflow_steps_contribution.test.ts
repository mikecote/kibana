/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerSecurityWorkflowSteps } from '../workflows/register_security_workflow_steps';
import { contribution } from './workflow_steps_contribution';

/** The ids Kibana registers: what `plugin.ts` registers (and `threat_intel/wiring.ts` adds). */
const registeredByKibana = () => {
  const steps: string[] = [];
  const triggers: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
    registerTriggerDefinition: (definition: { id: string }) => triggers.push(definition.id),
  } as unknown as WorkflowStepsRegistry;
  registerSecurityWorkflowSteps(registry, { threatIntelLogger: loggerMock.create() });
  return { steps, triggers };
};

describe('security_solution workflow-steps contribution', () => {
  it('registers every step and trigger Kibana registers in a process registry', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    const internalSteps = registry.getAllStepDefinitions().length;
    const internalTriggers = registry.getAllTriggerDefinitions().length;

    await contribution.register(registry, {
      host: {},
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
    });
    await registry.isReady();

    const kibana = registeredByKibana();
    expect(kibana.steps).toHaveLength(21);
    expect(kibana.triggers).toHaveLength(8);
    kibana.steps.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    kibana.triggers.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.steps.length);
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + kibana.triggers.length
    );
    expect(registry.hasStepDefinition('threat_intel.fetch_source')).toBe(true);
  });
});
