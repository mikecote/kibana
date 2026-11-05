/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerAlertingV2WorkflowSteps } from '../lib/workflow_extensions/register_alerting_v2_workflow_steps';
import { contribution } from './workflow_steps_contribution';

/** The ids Kibana registers: what `bind_on_setup` registers through the same function. */
const registeredByKibana = () => {
  const steps: string[] = [];
  const triggers: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
    registerTriggerDefinition: (definition: { id: string }) => triggers.push(definition.id),
  } as unknown as WorkflowStepsRegistry;
  registerAlertingV2WorkflowSteps(registry, {
    getAlertEventsClient: jest.fn(),
    checkAlertWritePrivilege: jest.fn(),
  });
  return { steps, triggers };
};

describe('alerting_v2 workflow-steps contribution', () => {
  it('registers every step and trigger Kibana registers in a process registry', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    const internalSteps = registry.getAllStepDefinitions().length;
    const internalTriggers = registry.getAllTriggerDefinitions().length;

    await contribution.register(registry, {
      host: {
        elasticsearch: { asInternalUser: {} },
        featureFlags: { getStringValue$: () => ({ subscribe: jest.fn() }) },
        plugins: { security: { authz: {} } },
      },
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
    });
    await registry.isReady();

    const kibana = registeredByKibana();
    expect(kibana.steps).toEqual(['alerting.create_alert']);
    expect(kibana.triggers.length).toBeGreaterThanOrEqual(3);
    kibana.steps.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    kibana.triggers.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.steps.length);
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + kibana.triggers.length
    );
  });
});
