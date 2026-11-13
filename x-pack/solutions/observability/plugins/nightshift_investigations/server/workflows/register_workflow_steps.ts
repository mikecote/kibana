/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerNightshiftProcessSteps } from './register_process_steps';
import { triggerInvestigationStepDefinition } from '../step_definitions/trigger_investigation';
import { ensureInvestigationAgentStepDefinition } from '../step_definitions/ensure_investigation_agent';
import { sendNotificationsStepDefinition } from '../step_definitions/send_notifications';
import { handleInvestigationFailureStepDefinition } from '../step_definitions/handle_investigation_failure';
import { renderSlackMessageStepDefinition } from '../step_definitions/render_slack_message';
import { obtainSandboxStepDefinition } from '../step_definitions/obtain_sandbox';
import { cortexHydrateStepDefinition } from '../step_definitions/cortex_hydrate';
import { memoryMaterializeToSandboxStepDefinition } from '../step_definitions/memory_materialize_to_sandbox';
import { decisionTreeHydrateStepDefinition } from '../step_definitions/decision_tree_hydrate';
import { cortexOptimizeStepDefinition } from '../step_definitions/cortex_optimize';
import { memoryOptimizeStepDefinition } from '../step_definitions/memory_optimize';
import { decisionTreeReinforceStepDefinition } from '../step_definitions/decision_tree_reinforce';
import type { InvestigationNotificationDeps } from '../lib/notifications/send_investigation_notifications';
import type { GetTriggerEmitter } from '../types';
import type { NightshiftTelemetryClient } from '../telemetry';

type NightshiftProcessStepDependencies = Parameters<typeof registerNightshiftProcessSteps>[1];

export interface NightshiftWorkflowStepDependencies
  extends NightshiftProcessStepDependencies,
    InvestigationNotificationDeps {
  getAutomationsSoClient: Parameters<typeof triggerInvestigationStepDefinition>[1];
  getAgentBuilder: Parameters<typeof ensureInvestigationAgentStepDefinition>[0]['getAgentBuilder'];
  getAgentAvailability: Parameters<
    typeof ensureInvestigationAgentStepDefinition
  >[0]['getAgentAvailability'];
  getSandboxStart: Parameters<typeof obtainSandboxStepDefinition>[0]['getSandboxStart'];
  getTriggerEmitter: GetTriggerEmitter;
  analytics: Parameters<typeof cortexHydrateStepDefinition>[0]['analytics'];
  telemetry: NightshiftTelemetryClient;
  isCortexEnabled: () => boolean;
  isMemoryEnabled: () => boolean;
}

/** Registers every native Nightshift workflow step through the same factories in Main and workers. */
export const registerNightshiftWorkflowSteps = (
  registry: WorkflowStepsRegistry,
  deps: NightshiftWorkflowStepDependencies
): void => {
  registerNightshiftProcessSteps(registry, deps);
  registry.registerStepDefinition(
    triggerInvestigationStepDefinition(deps.getInvestigationsClient, deps.getAutomationsSoClient)
  );
  registry.registerStepDefinition(ensureInvestigationAgentStepDefinition(deps));
  registry.registerStepDefinition(sendNotificationsStepDefinition(deps));
  registry.registerStepDefinition(handleInvestigationFailureStepDefinition(deps));
  registry.registerStepDefinition(renderSlackMessageStepDefinition(deps));
  registry.registerStepDefinition(
    obtainSandboxStepDefinition({
      getSandboxStart: deps.getSandboxStart,
      logger: deps.logger.get('sandbox'),
    })
  );
  registry.registerStepDefinition(
    cortexHydrateStepDefinition({
      getSandboxStart: deps.getSandboxStart,
      analytics: deps.analytics,
      logger: deps.logger.get('cortex'),
      isEnabled: deps.isCortexEnabled,
    })
  );
  registry.registerStepDefinition(
    memoryMaterializeToSandboxStepDefinition({
      getSandboxStart: deps.getSandboxStart,
      logger: deps.logger.get('memory'),
      isEnabled: deps.isMemoryEnabled,
      telemetry: deps.telemetry,
    })
  );
  registry.registerStepDefinition(
    decisionTreeHydrateStepDefinition({
      getSandboxStart: deps.getSandboxStart,
      logger: deps.logger.get('decision_trees'),
      isEnabled: deps.isDecisionTreesEnabled,
    })
  );
  const optimize = {
    getAgentBuilder: deps.getAgentBuilder,
    getInference: deps.getInference,
    getSavedObjects: deps.getSavedObjects,
    getUiSettings: deps.getUiSettings,
  };
  registry.registerStepDefinition(
    cortexOptimizeStepDefinition({
      ...optimize,
      analytics: deps.analytics,
      logger: deps.logger.get('cortex'),
      isEnabled: deps.isCortexEnabled,
    })
  );
  registry.registerStepDefinition(
    memoryOptimizeStepDefinition({
      ...optimize,
      logger: deps.logger.get('memory'),
      isEnabled: deps.isMemoryEnabled,
      telemetry: deps.telemetry,
    })
  );
  registry.registerStepDefinition(
    decisionTreeReinforceStepDefinition({
      getAgentBuilder: deps.getAgentBuilder,
      isEnabled: deps.isDecisionTreesEnabled,
    })
  );
};
