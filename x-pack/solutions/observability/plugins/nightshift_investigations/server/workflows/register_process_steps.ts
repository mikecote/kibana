/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, Logger } from '@kbn/core/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { composeHydrateNotificationsStepDefinition } from '../step_definitions/compose_hydrate_notifications';
import { decisionTreePrepareStepDefinition } from '../step_definitions/decision_tree_prepare';
import { resolveModelStepDefinition } from '../step_definitions/resolve_model';

/**
 * The steps that need nothing of Agent Builder, the sandbox or the plugin's clients: the plugin
 * registers them in `setup()` and the task process of the workflow task types registers the same
 * ones (`task_types/workflow_steps_contribution.ts`), with the services of its host.
 */
export const registerNightshiftProcessSteps = (
  registry: WorkflowStepsRegistry,
  {
    getInference,
    getSavedObjects,
    getUiSettings,
    getTelemetryConnectorId,
    isDecisionTreesEnabled,
    logger,
  }: {
    getInference: () => InferenceServerStart | undefined;
    getSavedObjects: () => CoreStart['savedObjects'] | undefined;
    getUiSettings: () => CoreStart['uiSettings'] | undefined;
    getTelemetryConnectorId: () => string | undefined;
    isDecisionTreesEnabled: () => boolean;
    logger: Logger;
  }
): void => {
  registry.registerStepDefinition(
    resolveModelStepDefinition({
      getInference,
      getSavedObjects,
      getUiSettings,
      logger: logger.get('resolve_model'),
    })
  );
  registry.registerStepDefinition(composeHydrateNotificationsStepDefinition());
  // Registered unconditionally: the combined optimize workflow installs with Cortex or Memory,
  // so a trees-off install would otherwise reference an unknown step type. The handler no-ops on
  // the flag.
  registry.registerStepDefinition(
    decisionTreePrepareStepDefinition({
      getTelemetryConnectorId,
      logger: logger.get('decision_trees'),
      isEnabled: isDecisionTreesEnabled,
    })
  );
};
