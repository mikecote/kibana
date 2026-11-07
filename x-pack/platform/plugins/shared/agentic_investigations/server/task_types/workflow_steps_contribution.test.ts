/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContributionContext } from '@kbn/workflows-extensions/server';
import { AttachImpactStepId, GetImpactStepId } from '../../common/impact/step_types';
import { ReopenInvestigationStepId } from '../../common/investigations/step_types';
import { AppendWorkflowExecutionIdStepId } from '../../common/workflow_execution/step_types';
import { contribution } from './workflow_steps_contribution';
import { AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID } from './agentic_investigations_task_process_settings';

describe('agentic investigations workflow worker registrations', () => {
  it('registers all native steps without accessing execution services during registration', async () => {
    const logger = loggingSystemMock.createLogger();
    const registry = createServerStepRegistry(logger);
    const getService = jest.fn();
    const context: WorkflowStepsContributionContext = {
      host: {},
      logger,
      isServerless: false,
      kibanaVersion: '9.6.0',
      settings: {
        [AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID]: {
          escalationsEnabled: true,
          securityEnabled: true,
          spacesEnabled: true,
          proposalsEnabled: true,
        },
      },
      services: {
        stepRegistry: registry,
        registerRunCompletion: jest.fn(),
        registerService: jest.fn(),
        getService,
        getExecutionEngine: jest.fn(),
        getUnsecuredActionsClient: jest.fn(),
        getActionsClientWithRequest: jest.fn(),
        executionDataClients: {
          createWorkflowDataClient: jest.fn(),
          createStepDataClient: jest.fn(),
        },
        emitEvent: jest.fn(),
      },
    };
    await contribution.register(registry, context);
    await registry.isReady();
    expect(
      registry
        .getAllStepDefinitions()
        .map(({ id }) => id)
        .filter((id) => id.startsWith('investigations.'))
        .sort()
    ).toEqual(
      [
        AttachImpactStepId,
        GetImpactStepId,
        ReopenInvestigationStepId,
        AppendWorkflowExecutionIdStepId,
      ].sort()
    );
    expect(getService).not.toHaveBeenCalled();
    const disabledRegistry = createServerStepRegistry(logger);
    await contribution.register(disabledRegistry, { ...context, settings: {} });
    await disabledRegistry.isReady();
    expect(disabledRegistry.hasStepDefinition(AttachImpactStepId)).toBe(false);
  });
});
