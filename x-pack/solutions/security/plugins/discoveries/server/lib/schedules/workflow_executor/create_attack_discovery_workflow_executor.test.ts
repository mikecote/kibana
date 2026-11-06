/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import type { AttackDiscoveryExecutorOptions } from '@kbn/attack-discovery-schedules-common';
import { createAttackDiscoveryWorkflowExecutor } from './create_attack_discovery_workflow_executor';
import type { AttackDiscoveryWorkflowExecutorDeps } from '@kbn/discoveries/impl/attack_discovery/workflow_executor_contribution';
import { workflowExecutor } from '.';

jest.mock('.', () => ({ workflowExecutor: jest.fn().mockResolvedValue({ state: {} }) }));

const mockIsWorkflowsEnabled = jest.fn();
jest.mock('@kbn/discoveries/impl/lib/helpers/is_workflows_enabled', () => ({
  isWorkflowsEnabled: (...args: unknown[]) => mockIsWorkflowsEnabled(...args),
}));

describe('createAttackDiscoveryWorkflowExecutor', () => {
  const deps = {
    featureFlags: { getBooleanValue$: jest.fn() },
    logger: loggerMock.create(),
  } as unknown as AttackDiscoveryWorkflowExecutorDeps;

  const optionsWithHeader = (authorization?: string) =>
    ({
      executionId: 'exec-1',
      spaceId: 'my-space',
      params: {},
      services: {
        scopedClusterClient: {
          asCurrentUser: { transport: { headers: authorization ? { authorization } : {} } },
        },
      },
    } as unknown as AttackDiscoveryExecutorOptions);

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsWorkflowsEnabled.mockResolvedValue(true);
  });

  it('runs the workflow executor with a fake request in the space and credential of the rule', async () => {
    const options = optionsWithHeader('ApiKey abc');

    await createAttackDiscoveryWorkflowExecutor(deps)(options);

    const { deps: executorDeps } = (workflowExecutor as jest.Mock).mock.calls[0][0];
    expect(executorDeps.request.isFakeRequest).toBe(true);
    expect(executorDeps.request.spaceId).toBe('my-space');
    expect(executorDeps.request.headers.authorization).toBe('ApiKey abc');
    expect(executorDeps.logger).toBe(deps.logger);
  });

  it('never grants an API key: the credential is the one the rule already runs with', async () => {
    const apiKeys = { grantAsInternalUser: jest.fn(), invalidateAsInternalUser: jest.fn() };

    await createAttackDiscoveryWorkflowExecutor({ ...deps, apiKeys })(
      optionsWithHeader('ApiKey abc')
    );

    expect(apiKeys.grantAsInternalUser).not.toHaveBeenCalled();
  });

  it('skips the run as a no-op when the feature flag is off', async () => {
    mockIsWorkflowsEnabled.mockResolvedValue(false);

    const result = await createAttackDiscoveryWorkflowExecutor(deps)(
      optionsWithHeader('ApiKey abc')
    );

    expect(result).toEqual({ state: {} });
    expect(workflowExecutor).not.toHaveBeenCalled();
  });
});
