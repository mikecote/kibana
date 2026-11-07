/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { InferenceWorkflowsPlugin } from '../plugin';
import { contribution } from './workflow_steps_contribution';

/** The ids Kibana registers: what `plugin.ts` registers in `setup()`. */
const registeredByKibana = () => {
  const steps: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
    registerTriggerDefinition: jest.fn(),
  } as unknown as WorkflowStepsRegistry;
  new InferenceWorkflowsPlugin().setup(
    { getStartServices: () => new Promise(() => {}) } as never,
    {
      workflowsExtensions: registry,
      searchInferenceEndpoints: { features: { register: jest.fn() } },
    } as never
  );
  return steps;
};

describe('inference_workflows workflow-steps contribution', () => {
  it('registers every step Kibana registers in a process registry', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    const internalSteps = registry.getAllStepDefinitions().length;

    await contribution.register(registry, {
      host: { elasticsearch: {}, savedObjects: {}, uiSettings: {} },
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: { inferenceFeatures: { features: [] } },
      services: {
        stepRegistry: createServerStepRegistry(loggerMock.create()),
        registerService: jest.fn(),
        registerRunCompletion: jest.fn(),
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
    expect(kibana.sort()).toEqual(['ai.classify', 'ai.prompt', 'ai.summarize']);
    kibana.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);
  });

  it('declares the saved object and the ui settings the inference services read', () => {
    expect(contribution.declares?.savedObjectTypes?.map(({ name }) => name)).toEqual([
      'inference-settings',
    ]);
    const settings = Object.assign({}, ...(contribution.declares?.uiSettings ?? []));
    expect(Object.keys(settings)).toEqual(
      expect.arrayContaining([
        'genAiSettings:defaultAIConnector',
        'genAiSettings:defaultAIConnectorOnly',
        'genAiSettings:inferenceStreaming',
        'genAiSettings:tokenUsageTracking',
      ])
    );
  });
});
