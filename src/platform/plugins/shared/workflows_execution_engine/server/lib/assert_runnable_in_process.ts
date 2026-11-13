/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { DeclinedRunError } from '@kbn/task-manager-plugin/server/task_running/errors';
import { TriggerTypes } from '@kbn/workflows';
import type { WorkflowYaml } from '@kbn/workflows';
import { isAtomic, WorkflowGraph } from '@kbn/workflows/graph';
import { defaultWorkflowSettings } from '../default_workflow_settings';

/**
 * What the process (or Kibana) that is about to run a workflow can serve. The runtime hands this to
 * its `preflight` hook; the hook decides, before any write, whether the run is declined.
 */
export interface WorkflowRunCapabilities {
  /** Whether a step type is registered (custom steps from other plugins). */
  hasStepDefinition(stepType: string): boolean;
  /** Whether a trigger type is registered (custom triggers from other plugins). */
  hasTriggerDefinition(triggerType: string): boolean;
  /**
   * Whether a step type is served by a connector (the actions client) rather than the step registry.
   * Built-in steps (`if`, `foreach`, `elasticsearch.*`, `kibana.*`, `data.set`, ...) never need the
   * registry; every other step type is looked up in the registry unless this says it is a connector.
   */
  isConnectorStepType?(step: { type: string; config: Record<string, unknown> }): boolean;
  /**
   * Why a step cannot be served here as Kibana would serve it (such as a feature it names that this
   * process does not know), or `undefined`. Absent in Kibana.
   */
  checkStep?(step: { type: string; config: Record<string, unknown> }): string | undefined;
  /** Whether workflows can run as a service account (`settings.run_as`) here. */
  canRunAs(): boolean;
}

/** What a workflow definition needs from the process that runs it. */
export interface WorkflowRequirements {
  /** Step types that are served by the step registry (or connectors), not built into the engine. */
  stepTypes: string[];
  /** Trigger types the workflow declares that are not built in (`manual`, `alert`, `scheduled`). */
  triggerTypes: string[];
  /** The steps as written (type and configuration), for the checks of `WorkflowRunCapabilities.checkStep`. */
  steps: Array<{ type: string; config: Record<string, unknown> }>;
  /** The service account the workflow runs as (`settings.run_as`), if any. */
  runAs: string | undefined;
  /** Set when the definition cannot be compiled into a graph; the run itself then fails normally. */
  graphError?: string;
}

const BUILT_IN_TRIGGER_TYPES: ReadonlySet<string> = new Set(TriggerTypes);

/**
 * Collects every step type and trigger type a workflow definition uses. Steps are read from the
 * compiled execution graph, so nested `foreach`, `if`, `while`, `switch`, `parallel`, `try` and
 * `retry` bodies and the `on-failure` fallback steps are all covered.
 */
export const collectWorkflowRequirements = (definition: WorkflowYaml): WorkflowRequirements => {
  const triggerTypes = new Set<string>();
  for (const trigger of definition.triggers ?? []) {
    if (trigger?.type && !BUILT_IN_TRIGGER_TYPES.has(trigger.type)) {
      triggerTypes.add(trigger.type);
    }
  }
  const runAs = definition.settings?.run_as;

  const stepTypes = new Set<string>();
  const steps: WorkflowRequirements['steps'] = [];
  try {
    const graph = WorkflowGraph.fromWorkflowDefinition(definition, defaultWorkflowSettings);
    for (const node of graph.getAllNodes()) {
      // Atomic nodes are the steps that are not built into the engine: registered custom steps and
      // connector steps. Everything else has its own node type.
      if (isAtomic(node) && node.stepType) {
        stepTypes.add(node.stepType);
        steps.push({
          type: node.stepType,
          config: (node as { configuration?: Record<string, unknown> }).configuration ?? {},
        });
      }
    }
  } catch (error) {
    return {
      stepTypes: [],
      steps: [],
      triggerTypes: [...triggerTypes],
      runAs,
      graphError: error instanceof Error ? error.message : String(error),
    };
  }

  return { stepTypes: [...stepTypes].sort(), steps, triggerTypes: [...triggerTypes].sort(), runAs };
};

export interface MissingWorkflowCapabilities {
  missingStepTypes: string[];
  missingTriggerTypes: string[];
  /** Why steps cannot be served as Kibana would (`checkStep`), as `<step type>: <reason>`. */
  unsupportedSteps: string[];
  /** The workflow runs as a service account and `canRunAs()` is false. */
  runAsUnavailable: boolean;
  requirements: WorkflowRequirements;
}

/** The step types, trigger types and service account use of a workflow that `capabilities` cannot serve. */
export const findMissingWorkflowCapabilities = (
  definition: WorkflowYaml,
  capabilities: WorkflowRunCapabilities
): MissingWorkflowCapabilities => {
  const requirements = collectWorkflowRequirements(definition);
  return {
    // Per step, because whether a step is a connector step depends on how it is written (`connector-id`).
    missingStepTypes: [
      ...new Set(
        requirements.steps
          .filter(
            (step) =>
              !capabilities.hasStepDefinition(step.type) &&
              !capabilities.isConnectorStepType?.(step)
          )
          .map((step) => step.type)
      ),
    ].sort(),
    missingTriggerTypes: requirements.triggerTypes.filter(
      (type) => !capabilities.hasTriggerDefinition(type)
    ),
    unsupportedSteps: requirements.steps.flatMap((step) => {
      const reason = capabilities.checkStep?.(step);
      return reason ? [`${step.type}: ${reason}`] : [];
    }),
    runAsUnavailable: requirements.runAs !== undefined && !capabilities.canRunAs(),
    requirements,
  };
};

/**
 * Throws a {@link DeclinedRunError} when the workflow
 * uses a step type or trigger type the process does not have, or runs as a service account where
 * that is not available. Call it before anything is written.
 */
export const assertRunnableInProcess = (
  definition: WorkflowYaml,
  capabilities: WorkflowRunCapabilities
): void => {
  const missing = findMissingWorkflowCapabilities(definition, capabilities);
  const reasons: string[] = [];
  if (missing.missingStepTypes.length > 0) {
    reasons.push(
      `step types not available in this process: ${missing.missingStepTypes.join(', ')}`
    );
  }
  if (missing.missingTriggerTypes.length > 0) {
    reasons.push(
      `trigger types not available in this process: ${missing.missingTriggerTypes.join(', ')}`
    );
  }
  if (missing.unsupportedSteps.length > 0) {
    reasons.push(`steps not supported in this process: ${missing.unsupportedSteps.join('; ')}`);
  }
  if (missing.runAsUnavailable) {
    reasons.push('service account execution (settings.run_as) is not available in this process');
  }
  if (reasons.length > 0) {
    throw new DeclinedRunError(`Workflow cannot run in this process: ${reasons.join('; ')}`);
  }
};

/** What the runtime tells its `preflight` hook about the task that is about to run. */
export interface WorkflowPreflightContext {
  taskType: 'workflow:run' | 'workflow:resume' | 'workflow:scheduled';
  /** The execution a `workflow:run` or `workflow:resume` task is about to run. */
  workflowRunId?: string;
  /** The workflow a `workflow:scheduled` task is about to run. */
  workflowId?: string;
  spaceId: string;
  capabilities: WorkflowRunCapabilities;
  /**
   * The definition the run is about to execute: that of the persisted execution (run, resume) or of
   * the saved workflow (scheduled); `undefined` when it does not exist (the run handles that).
   */
  loadWorkflowDefinition(): Promise<WorkflowYaml | undefined>;
}

/**
 * Called at the top of each of the three task functions, before anything is written. It may throw a
 * {@link DeclinedRunError} to fail the task without executing it in Kibana. A no-op in Kibana.
 */
export type WorkflowPreflight = (context: WorkflowPreflightContext) => void | Promise<void>;

/** The preflight of a task process: declines what {@link assertRunnableInProcess} finds missing. */
export const assertRunnableInProcessPreflight: WorkflowPreflight = async ({
  capabilities,
  loadWorkflowDefinition,
}) => {
  const definition = await loadWorkflowDefinition();
  if (definition) {
    assertRunnableInProcess(definition, capabilities);
  }
};
