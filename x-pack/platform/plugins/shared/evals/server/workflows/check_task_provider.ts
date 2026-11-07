/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

const EVALS_STEP_PREFIX = 'ai.evals.';

const collectTaskRefs = (value: unknown, refs: string[] = []): string[] => {
  if (value === null || typeof value !== 'object') return refs;
  const record = value as Record<string, unknown>;
  if (typeof record.task_ref === 'string' && record.task_ref.length > 0) {
    refs.push(record.task_ref);
  }
  if (record.task !== undefined) collectTaskRefs(record.task, refs);
  return refs;
};

/**
 * Checks literal task references against the current execution registry; templates resolve when the step runs.
 */
export const checkEvalsTaskProvider = (
  step: { type: string; config: Record<string, unknown> },
  hasTaskProvider: (name: string) => boolean
): string | undefined => {
  if (!step.type.startsWith(EVALS_STEP_PREFIX)) return undefined;
  for (const taskRef of collectTaskRefs(step.config.with)) {
    if (!taskRef.includes('{{') && !hasTaskProvider(taskRef)) {
      return `the task provider "${taskRef}" is not registered in this process`;
    }
  }
  return undefined;
};
