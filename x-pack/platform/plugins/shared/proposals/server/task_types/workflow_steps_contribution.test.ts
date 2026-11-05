/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck, WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerStepDefinitions } from '../step_types';
import { contribution } from './workflow_steps_contribution';

/** The ids Kibana registers: what `plugin.ts` registers through the same function. */
const registeredByKibana = () => {
  const steps: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => steps.push(definition.id),
  } as unknown as WorkflowStepsRegistry;
  registerStepDefinitions({
    workflowsExtensions: registry,
    getProposalsService: jest.fn(),
    resolveUser: jest.fn(),
    privileges: {} as never,
  });
  return steps;
};

describe('proposals workflow-steps contribution', () => {
  it('registers every step Kibana registers in a process registry, and declines what needs Agent Builder', async () => {
    const registry = createServerStepRegistry(loggerMock.create());
    const internalSteps = registry.getAllStepDefinitions().length;
    const checks: WorkflowStepRunCheck[] = [];

    await contribution.register(registry, {
      host: {
        elasticsearch: { asInternalUser: {} },
        security: {},
        userProfile: {},
        plugins: { security: { authz: {} } },
      },
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
      registerRunCheck: (check) => checks.push(check),
    });
    await registry.isReady();

    const kibana = registeredByKibana();
    expect(kibana).toHaveLength(7);
    kibana.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.length);

    const declined = (type: string) =>
      checks.map((check) => check({ type, config: {} })).find(Boolean);
    expect(declined('proposals.createProposal')).toMatch(/Agent Builder/);
    expect(declined('proposals.cloneProposal')).toMatch(/Agent Builder/);
    expect(declined('proposals.getProposal')).toBeUndefined();
  });
});
