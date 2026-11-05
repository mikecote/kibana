/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isDeclinedRunError } from '@kbn/task-manager-plugin/server/task_running/errors';
import type { WorkflowYaml } from '@kbn/workflows';
import {
  assertRunnableInProcess,
  assertRunnableInProcessPreflight,
  collectWorkflowRequirements,
  findMissingWorkflowCapabilities,
} from './assert_runnable_in_process';
import type { WorkflowRunCapabilities } from './assert_runnable_in_process';

const definition = (partial: Record<string, unknown>): WorkflowYaml =>
  ({ name: 'wf', enabled: true, triggers: [{ type: 'manual' }], steps: [], ...partial } as never);

const capabilities = (
  overrides: Partial<WorkflowRunCapabilities> & { steps?: string[]; triggers?: string[] } = {}
): WorkflowRunCapabilities => ({
  hasStepDefinition: (type) => (overrides.steps ?? []).includes(type),
  hasTriggerDefinition: (type) => (overrides.triggers ?? []).includes(type),
  canRunAs: () => false,
  ...overrides,
});

const nestedWorkflow = definition({
  triggers: [
    { type: 'manual' },
    { type: 'scheduled', with: { every: '1h' } },
    { type: 'cases.created' },
  ],
  steps: [
    { name: 'es', type: 'elasticsearch.search', with: { index: 'a' } },
    { name: 'set', type: 'data.set', with: { a: 1 } },
    {
      name: 'loop',
      type: 'foreach',
      foreach: '["a"]',
      steps: [
        {
          name: 'branch',
          type: 'if',
          condition: 'true',
          steps: [{ name: 'deep', type: 'cases.createCase', with: {} }],
          else: [{ name: 'other', type: 'slack', 'connector-id': 'c', with: { message: 'hi' } }],
        },
      ],
    },
    { name: 'agent', type: 'agent.run', with: {} },
  ],
  settings: {
    'on-failure': { fallback: [{ name: 'notify', type: 'cases.addComment', with: {} }] },
  },
});

describe('collectWorkflowRequirements', () => {
  it('collects the registry and connector step types, nested and fallback steps included', () => {
    const requirements = collectWorkflowRequirements(nestedWorkflow);
    expect(requirements.graphError).toBeUndefined();
    expect(requirements.stepTypes).toEqual([
      'agent.run',
      'cases.addComment',
      'cases.createCase',
      'slack',
    ]);
  });

  it('skips built-in steps and the built-in trigger types', () => {
    const requirements = collectWorkflowRequirements(nestedWorkflow);
    expect(requirements.stepTypes).not.toContain('elasticsearch.search');
    expect(requirements.stepTypes).not.toContain('data.set');
    expect(requirements.triggerTypes).toEqual(['cases.created']);
  });

  it('reports the service account of settings.run_as', () => {
    expect(collectWorkflowRequirements(definition({ settings: { run_as: 'sa-1' } })).runAs).toBe(
      'sa-1'
    );
    expect(collectWorkflowRequirements(definition({})).runAs).toBeUndefined();
  });

  it('reports a graph that cannot be built instead of throwing', () => {
    const broken = definition({
      steps: [
        {
          name: 'par',
          type: 'parallel',
          branches: [
            {
              name: 'b1',
              steps: [{ name: 'nested', type: 'foreach', foreach: '[1]', steps: [] }],
            },
          ],
        },
      ],
    });
    const requirements = collectWorkflowRequirements(broken);
    expect(requirements.graphError).toEqual(expect.any(String));
    expect(requirements.stepTypes).toEqual([]);
  });
});

describe('findMissingWorkflowCapabilities', () => {
  it('returns the step types and trigger types that are not registered', () => {
    const missing = findMissingWorkflowCapabilities(
      nestedWorkflow,
      capabilities({ steps: ['cases.createCase'], isConnectorStepType: (type) => type === 'slack' })
    );
    expect(missing.missingStepTypes).toEqual(['agent.run', 'cases.addComment']);
    expect(missing.missingTriggerTypes).toEqual(['cases.created']);
    expect(missing.runAsUnavailable).toBe(false);
  });

  it('is empty when everything is registered', () => {
    const missing = findMissingWorkflowCapabilities(
      nestedWorkflow,
      capabilities({
        steps: ['agent.run', 'cases.addComment', 'cases.createCase', 'slack'],
        triggers: ['cases.created'],
      })
    );
    expect(missing.missingStepTypes).toEqual([]);
    expect(missing.missingTriggerTypes).toEqual([]);
  });

  it('detects run_as where service accounts are unavailable', () => {
    const wf = definition({ settings: { run_as: 'sa-1' } });
    expect(findMissingWorkflowCapabilities(wf, capabilities()).runAsUnavailable).toBe(true);
    expect(
      findMissingWorkflowCapabilities(wf, capabilities({ canRunAs: () => true })).runAsUnavailable
    ).toBe(false);
  });
});

describe('assertRunnableInProcess', () => {
  it('does not throw when the process can serve the workflow', () => {
    expect(() =>
      assertRunnableInProcess(
        nestedWorkflow,
        capabilities({
          steps: ['agent.run', 'cases.addComment', 'cases.createCase', 'slack'],
          triggers: ['cases.created'],
        })
      )
    ).not.toThrow();
  });

  it('throws a DeclinedRunError naming what is missing', () => {
    let error: unknown;
    try {
      assertRunnableInProcess(nestedWorkflow, capabilities({ steps: ['slack'] }));
    } catch (e) {
      error = e;
    }
    expect(isDeclinedRunError(error)).toBe(true);
    expect((error as Error).message).toContain('agent.run, cases.addComment, cases.createCase');
    expect((error as Error).message).toContain('cases.created');
  });

  it('declines a run_as workflow when service accounts are unavailable', () => {
    expect(() =>
      assertRunnableInProcess(definition({ settings: { run_as: 'sa-1' } }), capabilities())
    ).toThrow(/settings\.run_as/);
  });
});

describe('assertRunnableInProcessPreflight', () => {
  const context = (loaded: WorkflowYaml | undefined) => ({
    taskType: 'workflow:run' as const,
    workflowRunId: 'run-1',
    spaceId: 'default',
    capabilities: capabilities(),
    loadWorkflowDefinition: jest.fn().mockResolvedValue(loaded),
  });

  it('declines a definition the process cannot serve', async () => {
    await expect(
      assertRunnableInProcessPreflight(
        context(definition({ steps: [{ name: 'a', type: 'x.y', with: {} }] }))
      )
    ).rejects.toMatchObject({ code: expect.any(String), reason: expect.stringContaining('x.y') });
  });

  it('lets a run without a definition through (the run handles it)', async () => {
    await expect(assertRunnableInProcessPreflight(context(undefined))).resolves.toBeUndefined();
  });
});
