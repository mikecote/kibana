/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderDefaultAiIndexId } from '@kbn/agent-builder-common';
import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck, WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { loggingSystemMock } from '@kbn/core/server/mocks';
import { registerStepDefinitions } from '../step_types';
import { mockKiStepTelemetry } from '../step_types/test_utils';
import { contribution } from './workflow_steps_contribution';

const registerContribution = async () => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const checks: WorkflowStepRunCheck[] = [];
  await contribution.register(registry, {
    host: {
      elasticsearch: { asInternalUser: {}, asScoped: jest.fn() },
      savedObjects: { getUnsafeInternalClient: jest.fn() },
      uiSettings: { asScopedToClient: jest.fn() },
      security: { authc: {}, audit: { asScoped: jest.fn() } },
      analytics: { reportEvent: jest.fn() },
      plugins: { security: { authz: {} } },
    },
    logger: loggingSystemMock.createLogger(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: {},
    registerRunCheck: (check) => checks.push(check),
  });
  await registry.isReady();
  return { registry, internalSteps, checks };
};

/** The ids Kibana registers: what `plugin.ts` registers through the same function. */
const registeredByKibana = (): string[] => {
  const ids: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => ids.push(definition.id),
    registerTriggerDefinition: jest.fn(),
  } as unknown as WorkflowStepsRegistry;
  const telemetry = mockKiStepTelemetry();
  registerStepDefinitions({
    workflowsExtensions: registry,
    ...telemetry,
    getAiIndexService: jest.fn(),
    isContextEngineEnabled: jest.fn(),
    checkWritePrivilege: jest.fn(),
    verifyKi: jest.fn(),
    feedbackAnalysis: {
      getAiIndexService: jest.fn(),
      getImprovementsService: jest.fn(),
      getAuditLogger: jest.fn(),
      isContextEngineEnabled: jest.fn(),
      isFeedbackLoopEnabled: jest.fn(),
      checkWritePrivilege: jest.fn(),
      logger: telemetry.logger,
    },
  });
  return ids;
};

/** Read the global `contextEngine:feedbackLoop` advanced setting, which a task process does not have. */
const KIBANA_ONLY_STEPS = [
  'context-engine.getFeedbackContext',
  'context-engine.recordImprovements',
];

describe('context engine workflow-steps contribution', () => {
  it('registers every step Kibana registers, except the ones that only Kibana serves', async () => {
    const { registry, internalSteps } = await registerContribution();
    const kibana = registeredByKibana();

    expect(kibana).toHaveLength(6);
    KIBANA_ONLY_STEPS.forEach((id) => {
      expect(kibana).toContain(id);
      expect(registry.hasStepDefinition(id)).toBe(false);
    });
    const served = kibana.filter((id) => !KIBANA_ONLY_STEPS.includes(id));
    served.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + served.length);
  });

  it('declares the per-space setting the steps read', () => {
    expect(contribution.declares?.uiSettings?.flatMap((defaults) => Object.keys(defaults))).toEqual(
      ['contextEngine:enabled']
    );
  });

  it('declines the steps that need what other plugins register in Kibana', async () => {
    const { checks } = await registerContribution();
    const decline = (type: string, config: Record<string, unknown>) =>
      checks.map((check) => check({ type, config })).find(Boolean);

    expect(
      decline('context-engine.createKi', { with: { ai_index_id: agentBuilderDefaultAiIndexId } })
    ).toMatch(/Agent Builder/);
    expect(
      decline('context-engine.updateKi', { with: { ai_index_id: '{{ inputs.index }}' } })
    ).toMatch(/template/);
    expect(
      decline('context-engine.createKi', {
        with: { ai_index_id: 'mine', verifiers: [{ workflow_id: 'w' }] },
      })
    ).toMatch(/workflows management/);
    expect(
      decline('context-engine.verifyKi', { with: { verifiers: '{{ inputs.verifiers }}' } })
    ).toMatch(/template/);

    expect(
      decline('context-engine.createKi', {
        with: { ai_index_id: 'mine', verifiers: ['esql_valid_syntax'] },
      })
    ).toBeUndefined();
    expect(decline('context-engine.deleteKi', { with: { ai_index_id: 'mine' } })).toBeUndefined();
    expect(
      decline('slack', { with: { ai_index_id: agentBuilderDefaultAiIndexId } })
    ).toBeUndefined();
  });
});
