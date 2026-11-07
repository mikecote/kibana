/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepRunCheck } from '@kbn/workflows-extensions/server';

/** The step types the process serves, which name an AI index (`ai_index_id`). */
const CONTEXT_ENGINE_STEP_PREFIX = 'context-engine.';

const isTemplate = (value: unknown): boolean => typeof value === 'string' && value.includes('{{');

/**
 * Why a task process cannot serve a Context Engine step as Kibana does, or `undefined`:
 * - A custom verifier workflow (`workflow_id`) is run and, when it times out, cancelled with the
 *   workflows management API, which a process does not have. Verifiers given as a template are
 *   only known when the step runs.
 */
export const checkContextEngineStep: WorkflowStepRunCheck = ({ type, config }) => {
  if (!type.startsWith(CONTEXT_ENGINE_STEP_PREFIX)) return undefined;
  const input = (config.with ?? {}) as Record<string, unknown>;

  const { verifiers } = input;
  if (isTemplate(verifiers)) {
    return 'verifiers is a template, which is only known when the step runs, and might name verifier workflows';
  }
  if (
    Array.isArray(verifiers) &&
    verifiers.some((verifier) => typeof verifier !== 'string' || isTemplate(verifier))
  ) {
    return 'verifier workflows are run and cancelled with the workflows management API, which a task process does not have';
  }
  return undefined;
};
