/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { investigationsTriggerCommonDefinitions } from '../../common/workflows/triggers';
import { cortexHydrateStepDefinition } from '../step_definitions/cortex_hydrate';
import { cortexOptimizeStepDefinition } from '../step_definitions/cortex_optimize';
import { decisionTreeHydrateStepDefinition } from '../step_definitions/decision_tree_hydrate';
import { decisionTreeReinforceStepDefinition } from '../step_definitions/decision_tree_reinforce';
import { ensureInvestigationAgentStepDefinition } from '../step_definitions/ensure_investigation_agent';
import { handleInvestigationFailureStepDefinition } from '../step_definitions/handle_investigation_failure';
import { memoryMaterializeToSandboxStepDefinition } from '../step_definitions/memory_materialize_to_sandbox';
import { memoryOptimizeStepDefinition } from '../step_definitions/memory_optimize';
import { obtainSandboxStepDefinition } from '../step_definitions/obtain_sandbox';
import { renderSlackMessageStepDefinition } from '../step_definitions/render_slack_message';
import { sendNotificationsStepDefinition } from '../step_definitions/send_notifications';
import { triggerInvestigationStepDefinition } from '../step_definitions/trigger_investigation';
import { registerNightshiftProcessSteps } from '../workflows/register_process_steps';
import { KIBANA_ONLY_NIGHTSHIFT_STEPS } from './kibana_only_steps';
import { contribution } from './workflow_steps_contribution';

const registerContribution = async (
  nightshift: Record<string, unknown> | null = {
    workflowsManagementAvailable: true,
    decisionTreesEnabled: false,
  }
) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const internalTriggers = registry.getAllTriggerDefinitions().length;
  await contribution.register(registry, {
    host: {
      elasticsearch: { asInternalUser: {}, asScoped: jest.fn() },
      savedObjects: { getScopedClient: jest.fn() },
      uiSettings: { asScopedToClient: jest.fn() },
    },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: nightshift ? { nightshiftInvestigations: nightshift } : {},
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
  return { registry, internalSteps, internalTriggers };
};

/** The ids Kibana registers: `plugin.ts` registers the process steps through the same function, and the others with these definitions. */
const registeredByKibana = (): string[] => {
  const ids: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id: string }) => ids.push(definition.id),
    registerTriggerDefinition: jest.fn(),
  } as unknown as WorkflowStepsRegistry;
  registerNightshiftProcessSteps(registry, {
    getInference: jest.fn(),
    getSavedObjects: jest.fn(),
    getUiSettings: jest.fn(),
    getTelemetryConnectorId: jest.fn(),
    isDecisionTreesEnabled: jest.fn(),
    logger: loggerMock.create(),
  });
  const any = {} as never;
  ids.push(
    ...[
      triggerInvestigationStepDefinition(any, any),
      ensureInvestigationAgentStepDefinition(any),
      sendNotificationsStepDefinition(any),
      handleInvestigationFailureStepDefinition(any),
      renderSlackMessageStepDefinition(any),
      obtainSandboxStepDefinition(any),
      cortexHydrateStepDefinition(any),
      memoryMaterializeToSandboxStepDefinition(any),
      decisionTreeHydrateStepDefinition(any),
      cortexOptimizeStepDefinition(any),
      memoryOptimizeStepDefinition(any),
      decisionTreeReinforceStepDefinition(any),
    ].map(({ id }) => id)
  );
  return ids;
};

describe('nightshift investigations workflow-steps contribution', () => {
  it('registers every step Kibana registers, except the ones that need Agent Builder or the sandbox', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution();
    const kibana = registeredByKibana();

    expect(kibana).toHaveLength(15);
    const declined = Object.keys(KIBANA_ONLY_NIGHTSHIFT_STEPS);
    declined.forEach((id) => {
      expect(kibana).toContain(id);
      expect(registry.hasStepDefinition(id)).toBe(false);
    });
    const served = kibana.filter((id) => !declined.includes(id));
    expect(served.sort()).toEqual([
      'nightshift.composeHydrateNotifications',
      'nightshift.decisionTreePrepare',
      'nightshift.resolveModel',
    ]);
    served.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + served.length);

    investigationsTriggerCommonDefinitions.forEach(({ id }) =>
      expect(registry.getTriggerDefinition(id)).toBeDefined()
    );
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + investigationsTriggerCommonDefinitions.length
    );
  });

  it('registers nothing when Kibana sent no settings, as when the plugin is disabled', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution(null);

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(registry.getAllTriggerDefinitions()).toHaveLength(internalTriggers);
  });

  it('registers only the triggers when Kibana has no workflows management plugin, as it does', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution({
      workflowsManagementAvailable: false,
      decisionTreesEnabled: false,
    });

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(registry.getAllTriggerDefinitions().length).toBe(
      internalTriggers + investigationsTriggerCommonDefinitions.length
    );
  });

  it('declares its settings', () => {
    expect(contribution.declares?.settings).toEqual(['nightshiftInvestigations']);
  });
});
