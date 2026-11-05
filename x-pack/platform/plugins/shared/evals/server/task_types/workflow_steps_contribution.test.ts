/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { createTaskProviderRegistry } from '../task_providers/registry';
import { registerEvalsWorkflowSteps } from '../workflows';
import { contribution } from './workflow_steps_contribution';

/** The ids Kibana registers: what `plugin.ts` registers through the same function. */
const registeredByKibana = () => {
  const steps: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
  } as unknown as WorkflowStepsRegistry;
  registerEvalsWorkflowSteps(registry, {
    logger: loggerMock.create(),
    taskProviderRegistry: createTaskProviderRegistry(),
    getInferenceStart: jest.fn(),
  });
  return steps;
};

describe('evals workflow-steps contribution', () => {
  it('registers every step Kibana registers in a process registry', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    const internalSteps = registry.getAllStepDefinitions().length;

    await contribution.register(registry, {
      host: { elasticsearch: {}, savedObjects: {}, uiSettings: {} },
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
      services: {
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
    expect(kibana).toHaveLength(8);
    kibana.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);
  });
});
