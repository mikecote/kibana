/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerSignificantEventsWorkflowSteps } from '../workflows/register_significant_events_workflow_steps';
import { contribution } from './workflow_steps_contribution';

/** The ids Kibana registers: what `plugin.ts` registers in `setup()`. */
const registeredByKibana = () => {
  const steps: string[] = [];
  const triggers: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
    registerTriggerDefinition: (definition: { id: string }) => triggers.push(definition.id),
  } as unknown as WorkflowStepsRegistry;
  registerSignificantEventsWorkflowSteps(registry, {
    getInference: () => undefined,
    getSavedObjects: () => undefined,
    getUiSettings: () => undefined,
    logger: loggerMock.create(),
  });
  return { steps, triggers };
};

describe('significant_events workflow-steps contribution', () => {
  it('registers every step and trigger Kibana registers in a process registry', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    const internalSteps = registry.getAllStepDefinitions().length;
    const internalTriggers = registry.getAllTriggerDefinitions().length;

    await contribution.register(registry, {
      host: { elasticsearch: {}, savedObjects: {}, uiSettings: {} },
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
      services: {
        stepRegistry: createServerStepRegistry(loggerMock.create()),
        registerService: jest.fn(),
        getService: jest.fn(),
        getExecutionEngine: jest.fn(),
        getUnsecuredActionsClient: jest.fn(),
        executionDataClients: {
          createWorkflowDataClient: jest.fn(),
          createStepDataClient: jest.fn(),
        },
        getActionsClientWithRequest: jest.fn(),
        emitEvent: jest.fn(),
      },
    });
    await registry.isReady();

    const kibana = registeredByKibana();
    expect(kibana.steps).toEqual(['significantEvents.resolveModel']);
    expect(kibana.triggers.length).toBeGreaterThan(0);
    kibana.steps.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    kibana.triggers.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.steps.length);
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + kibana.triggers.length
    );
  });
});
