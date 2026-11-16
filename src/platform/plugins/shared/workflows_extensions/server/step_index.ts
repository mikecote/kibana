/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { isPollStepDefinition } from './step_registry/types';
import type { PollCeilings, PollPolicy, ServerStepDefinition } from './step_registry/types';
import type { ServerTriggerDefinition } from './types';

/**
 * What a thin task process needs to run a step it does not register itself: whether it is
 * one-shot or durable (poll), the config keys the engine should forward (mirrors
 * `CustomStepImpl.getRenderedConfig`'s `configSchema.shape` filter), whether `onCancel` and
 * `start` are defined, and (for poll steps) the author's `policy`/`ceilings`. Everything else
 * (the actual handler code, `provides`/`register`) stays wherever the step is really registered;
 * a process with only the index builds a proxy that calls out for each phase. Sent as a required
 * task process setting ({@link WORKFLOW_STEP_INDEX_SETTINGS_ID}) in place of the `workflow.steps`
 * parity kind, which only compared ids: the index is the source of truth, so there is nothing
 * left to compare.
 */
export interface WorkflowStepIndexEntry {
  id: string;
  kind: 'handler' | 'poll';
  /** `Object.keys(configSchema.shape)`, or `[]` when the definition declares no `configSchema`. */
  configKeys: string[];
  hasOnCancel: boolean;
  /** Poll steps only: whether `start` is defined (poll-only steps omit it). */
  hasStart?: boolean;
  policy?: PollPolicy;
  ceilings?: PollCeilings;
}

/** The trigger equivalent of {@link WorkflowStepIndexEntry}, in place of the `workflow.triggers` parity kind. */
export interface WorkflowTriggerIndexEntry {
  id: string;
  requiresConnectorId?: boolean;
}

const getConfigKeys = (definition: ServerStepDefinition): string[] =>
  definition.configSchema ? Object.keys(definition.configSchema.shape) : [];

export const buildWorkflowStepIndex = (
  definitions: readonly ServerStepDefinition[]
): WorkflowStepIndexEntry[] =>
  definitions.map((definition) => ({
    id: definition.id,
    kind: isPollStepDefinition(definition) ? 'poll' : 'handler',
    configKeys: getConfigKeys(definition),
    hasOnCancel: Boolean(definition.onCancel),
    ...(isPollStepDefinition(definition)
      ? {
          hasStart: Boolean(definition.start),
          policy: definition.policy,
          ceilings: definition.ceilings,
        }
      : {}),
  }));

export const buildWorkflowTriggerIndex = (
  definitions: readonly ServerTriggerDefinition[]
): WorkflowTriggerIndexEntry[] =>
  definitions.map(({ id, requiresConnectorId }) => ({
    id,
    ...(requiresConnectorId ? { requiresConnectorId } : {}),
  }));

/** The id this index is sent under in `TaskTypeModule.settings` / `host.settings`. */
export const WORKFLOW_STEP_INDEX_SETTINGS_ID = 'workflowStepIndex';

export interface WorkflowStepIndexSettings {
  steps: WorkflowStepIndexEntry[];
  triggers: WorkflowTriggerIndexEntry[];
}
