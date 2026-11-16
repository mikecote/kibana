/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { StepCategory } from '@kbn/workflows';
import type {
  ServerHandlerStepDefinition,
  ServerPollStepDefinition,
  ServerTriggerDefinition,
  StepHandlerContext,
  WorkflowStepIndexEntry,
  WorkflowTriggerIndexEntry,
} from '@kbn/workflows-extensions/server';
import { KibanaApiCallError } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import { INVOKE_STEP_ROUTE_PATH } from '../routes/invoke_step';
import type { InvokeStepBody, InvokeStepResponseBody } from '../routes/invoke_step';

/**
 * Builds the worker's own `ServerStepDefinition` for one entry of Main's step index
 * ({@link WorkflowStepIndexEntry}): a thin proxy that forwards every phase
 * (`run`/`start`/`poll`/`cancel`) to {@link INVOKE_STEP_ROUTE_PATH} on Main instead of running the
 * real plugin handler here. This is how a worker with no `workflow-steps` contributions of its own
 * still serves a plugin-registered step (e.g. `cases.addAlerts`, `ai.agent`): Main runs the step,
 * the worker is just the engine's phase dispatcher and timing.
 *
 * `inputSchema`/`outputSchema` are left as `z.unknown()`: the real schemas live only on Main
 * (which validated the input before this step ran), so the proxy cannot narrow `context.input`'s
 * type; this only affects TypeScript inference for authors of future local steps, not runtime
 * behavior, since the engine validates against Main's schema when it builds the step node.
 */
export const buildStepProxyDefinition = (
  entry: WorkflowStepIndexEntry
): ServerHandlerStepDefinition | ServerPollStepDefinition => {
  const common = {
    id: entry.id,
    label: entry.id,
    description: `Proxy for "${entry.id}", registered on Main`,
    category: StepCategory.External,
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    configSchema: entry.configKeys.length
      ? z.object(Object.fromEntries(entry.configKeys.map((key) => [key, z.unknown().optional()])))
      : undefined,
  };

  const invoke = async (
    context: StepHandlerContext,
    phase: InvokeStepBody['phase'],
    extra?: { state?: unknown; attempt?: number }
  ): Promise<InvokeStepResponseBody> => {
    const body: InvokeStepBody = {
      phase,
      stepId: context.stepId,
      stepType: context.stepType,
      input: context.input,
      rawInput: context.rawInput,
      config: context.config as Record<string, unknown>,
      state: extra?.state,
      attempt: extra?.attempt,
      contextSnapshot: context.contextManager.getContext(),
      executionMetadata: context.contextManager.getExecutionMetadata(),
    };
    const result = await context.contextManager.callKibanaApi<InvokeStepResponseBody>({
      method: 'POST',
      path: INVOKE_STEP_ROUTE_PATH,
      body,
    });
    return result.body;
  };

  const onCancel = async (context: StepHandlerContext) => {
    try {
      await invoke(context, 'cancel');
    } catch (error) {
      // Best-effort: Main may have already finished or torn down this run.
      if (!(error instanceof KibanaApiCallError)) throw error;
    }
  };

  if (entry.kind === 'handler') {
    return {
      ...common,
      onCancel: entry.hasOnCancel ? onCancel : undefined,
      handler: async (context) => {
        const result = await invoke(context, 'run');
        if (result.error) return { error: new Error(result.error.message) };
        return { output: result.output };
      },
    };
  }

  return {
    ...common,
    policy: entry.policy,
    ceilings: entry.ceilings,
    onCancel: entry.hasOnCancel ? onCancel : undefined,
    start: entry.hasStart
      ? async (context) => {
          const result = await invoke(context, 'start');
          if (result.error) return { error: new Error(result.error.message) };
          if (result.output !== undefined) return { output: result.output };
          return {
            state: result.state as Record<string, unknown> | undefined,
            nextPollDelayMs: result.nextPollDelayMs,
          };
        }
      : undefined,
    poll: async (context) => {
      const result = await invoke(context, 'poll', {
        state: context.state,
        attempt: context.attempt,
      });
      if (result.error) return { error: new Error(result.error.message) };
      if (result.output !== undefined) return { output: result.output };
      return {
        state: result.state as Record<string, unknown> | undefined,
        nextPollDelayMs: result.nextPollDelayMs,
      };
    },
  };
};

/**
 * Builds the worker's own trigger definition for one entry of Main's trigger index. A placeholder,
 * permissive `eventSchema` is used: event validation for a trigger's payload happens on Main (where
 * the real schema lives and where the event is normally received), not in this process. The worker
 * only needs the trigger's existence and `requiresConnectorId` to route and gate a `listen` node.
 */
export const buildTriggerProxyDefinition = (
  entry: WorkflowTriggerIndexEntry
): ServerTriggerDefinition => ({
  id: entry.id,
  title: entry.id,
  description: `Proxy for "${entry.id}", registered on Main`,
  stability: 'stable',
  eventSchema: z.record(z.string(), z.unknown()),
  requiresConnectorId: entry.requiresConnectorId,
});
