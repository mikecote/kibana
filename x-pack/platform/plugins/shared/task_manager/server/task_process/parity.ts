/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DeclinedRunError } from '../task_running/errors';
import type { TaskHost } from '../task_type_module';

/**
 * What Kibana registered, by kind (such as `connectorTypes`): the ids a task process must have
 * registered too, or it cannot behave as Kibana does. Kibana sends it with the settings of every
 * dispatch, because what it holds can change (a plugin may add a connector type at any time).
 */
export type TaskProcessParity = Array<{ kind: string; ids: string[] }>;

/** How a module says what it registered, for one kind of parity. */
export interface TaskTypeParityHook {
  kind: string;
  /** The ids this process registered; read once per process, after the module has set itself up. */
  getIds: (host: TaskHost) => string[] | Promise<string[]>;
}

export interface MissingParity {
  kind: string;
  ids: string[];
}

/** The ids Kibana has for each kind that the process lacks. Kinds without a hook are not compared. */
export const findMissingParity = (
  expected: TaskProcessParity,
  actual: Record<string, string[]>
): MissingParity[] =>
  expected.flatMap(({ kind, ids }) => {
    const have = actual[kind];
    if (!have) return [];
    const haveSet = new Set(have);
    const lacking = ids.filter((id) => !haveSet.has(id));
    return lacking.length ? [{ kind, ids: lacking }] : [];
  });

/**
 * A check that runs once per process, before its first run: ids Kibana has that the process lacks
 * reject every run of the process with a warning that names them. A
 * process that was sent no parity (a remote one) is not checked, and says so once.
 */
export const createParityGuard = ({
  hooks = [],
  expected,
  logger,
  taskType,
}: {
  hooks?: TaskTypeParityHook[];
  expected?: TaskProcessParity;
  logger: { warn: (message: string) => void; debug: (message: string) => void };
  taskType: string;
}) => {
  let checked: Promise<MissingParity[]> | undefined;

  const compute = async (host: TaskHost): Promise<MissingParity[]> => {
    if (!hooks.length) return [];
    if (!expected) {
      logger.debug(
        `${taskType}: Kibana sent no parity, so what the process registered is unchecked`
      );
      return [];
    }
    const actual: Record<string, string[]> = {};
    for (const hook of hooks) actual[hook.kind] = await hook.getIds(host);
    const missing = findMissingParity(expected, actual);
    if (missing.length) {
      logger.warn(
        `${taskType}: this task process lacks what Kibana has registered, so its runs are declined: ${missing
          .map(({ kind, ids }) => `${kind} [${ids.join(', ')}]`)
          .join('; ')}`
      );
    }
    return missing;
  };

  return async (host: TaskHost): Promise<void> => {
    if (host.validateRegistrations && hooks.length) {
      const actual: Record<string, string[]> = {};
      for (const hook of hooks) actual[hook.kind] = await hook.getIds(host);
      const gap = await host.validateRegistrations(actual);
      if (gap) throw new DeclinedRunError(`Native registration mismatch: ${gap}`);
      return;
    }
    const missing = await (checked ??= compute(host));
    if (missing.length) {
      throw new DeclinedRunError(
        `The task process lacks ${missing
          .map(({ kind, ids }) => `${kind} [${ids.join(', ')}]`)
          .join('; ')}`
      );
    }
  };
};
