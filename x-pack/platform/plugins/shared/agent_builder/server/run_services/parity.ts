/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import { findMissingParity } from '@kbn/task-manager-plugin/server/task_process/parity';
import type { TaskProcessParity } from '@kbn/task-manager-plugin/server/task_process/parity';
import { getParityKind, REGISTRATION_KINDS } from './registration_recorder';
import type { RegistrationKind } from './registration_recorder';

/** Kibana: says what it registered of each kind, read at each dispatch to a task process. */
export const registerAgentBuilderParity = (
  workflowsExtensions: Pick<WorkflowsExtensionsServerPluginSetup, 'registerTaskProcessParity'>,
  getIds: () => Record<RegistrationKind, string[]>
) => {
  for (const kind of REGISTRATION_KINDS) {
    workflowsExtensions.registerTaskProcessParity(getParityKind(kind), () => getIds()[kind]);
  }
};

/**
 * How the registrations of a task process differ from Kibana's, as a message that names the ids, or
 * `undefined` when they are the same (or Kibana sent nothing to compare: a remote process).
 *
 * Both directions matter: an id Kibana has and the process lacks is a tool, skill or attachment type
 * the agent would not have, and an id only the process has (a plugin that is disabled in this Kibana
 * but contributes to the bundle) is one it would have and Kibana's agent does not. The runs that read
 * the registries (the agent, conversation and attachment steps) are declined on a message, because
 * they would behave differently from Kibana; the other runs are not affected.
 */
export const describeAgentBuilderParityGap = (
  expected: TaskProcessParity | undefined,
  actual: Record<RegistrationKind, string[]>
): string | undefined => {
  if (!expected) return undefined;
  const own = expected.filter(({ kind }) =>
    REGISTRATION_KINDS.some((registration) => getParityKind(registration) === kind)
  );
  const actualByKind = Object.fromEntries(
    REGISTRATION_KINDS.map((kind) => [getParityKind(kind), actual[kind]])
  );
  const lacking = findMissingParity(own, actualByKind);
  // The same comparison the other way round: what the process has that Kibana does not.
  const extra = findMissingParity(
    own.map(({ kind }) => ({ kind, ids: actualByKind[kind] })),
    Object.fromEntries(own.map(({ kind, ids }) => [kind, ids]))
  );
  const describe = (gaps: Array<{ kind: string; ids: string[] }>) =>
    gaps
      .map(({ kind, ids }) => `${kind.replace('agentBuilder.', '')} [${ids.join(', ')}]`)
      .join('; ');
  return (
    [
      lacking.length ? `lacks ${describe(lacking)}` : undefined,
      extra.length ? `has registered, and Kibana has not, ${describe(extra)}` : undefined,
    ]
      .filter(Boolean)
      .join('; ') || undefined
  );
};
