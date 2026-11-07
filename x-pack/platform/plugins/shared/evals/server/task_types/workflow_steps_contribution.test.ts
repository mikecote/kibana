/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck } from '@kbn/workflows-extensions/server';
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

const registerContribution = async (expected?: string[]) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const taskProviders = createTaskProviderRegistry();
  const checks: WorkflowStepRunCheck[] = [];
  await contribution.register(registry, {
    host: { elasticsearch: {}, savedObjects: {}, uiSettings: {} },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: {
      evalsTaskProviders: { names: expected ?? taskProviders.list().map(({ name }) => name) },
    },
    services: {
      stepRegistry: registry,
      registerService: jest.fn(),
      registerRunCompletion: jest.fn(),
      getService: jest.fn().mockReturnValue(taskProviders),
      getExecutionEngine: jest.fn(),
      getUnsecuredActionsClient: jest.fn(),
      executionDataClients: {
        createWorkflowDataClient: jest.fn(),
        createStepDataClient: jest.fn(),
      },
      getActionsClientWithRequest: jest.fn(),
      emitEvent: jest.fn(),
    },
    registerRunCheck: (check) => checks.push(check),
  });
  await registry.isReady();
  return { registry, internalSteps, taskProviders, checks };
};

describe('evals workflow-steps contribution', () => {
  it('registers every step Kibana registers in a process registry', async () => {
    const { registry, internalSteps } = await registerContribution();
    const kibana = registeredByKibana();
    expect(kibana).toHaveLength(8);
    kibana.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);
  });

  it('runs a provider contributed after step registration through the shared execution registry', async () => {
    const { registry, taskProviders, checks } = await registerContribution([
      'inference',
      'agentBuilder.converse',
      'suite',
    ]);
    const run = jest.fn().mockResolvedValue({ output: 'suite result', traceId: 'trace-1' });
    taskProviders.register({ name: 'suite', run });
    const step = registry.getStepDefinition('ai.evals.executeTask');
    if (!step || !('handler' in step)) throw new Error('Missing executeTask handler');
    const abortSignal = new AbortController().signal;
    const result = await step.handler({
      input: {
        example: { id: 'example-1', input: { value: 7 } },
        connector_id: 'model-1',
        task_ref: 'suite',
      },
      logger: loggerMock.create(),
      abortSignal,
      contextManager: { getContext: () => ({ workflow: { spaceId: 'default' } }) },
    } as never);
    expect(result).toEqual({ output: { output: 'suite result', trace_id: 'trace-1' } });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ input: { value: 7 }, connectorId: 'model-1', abortSignal })
    );
    expect(
      checks.map((check) =>
        check({ type: 'ai.evals.executeTask', config: { with: { task_ref: '{{ inputs.ref }}' } } })
      )
    ).toEqual([undefined]);
  });

  it('reports both missing and extra registrations against the dispatch snapshot', async () => {
    const { checks } = await registerContribution(['suite']);
    expect(checks[0]({ type: 'ai.evals.executeTask', config: {} })).toContain(
      'missing [suite], extra [inference, agentBuilder.converse]'
    );
    expect(checks[0]({ type: 'console', config: {} })).toBeUndefined();
  });
});
