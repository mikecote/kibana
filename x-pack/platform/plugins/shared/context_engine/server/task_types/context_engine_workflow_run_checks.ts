/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderDefaultAiIndexId } from '@kbn/agent-builder-common';
import type { WorkflowStepRunCheck } from '@kbn/workflows-extensions/server';

/** The step types the process serves, which name an AI index (`ai_index_id`). */
const CONTEXT_ENGINE_STEP_PREFIX = 'context-engine.';

const isTemplate = (value: unknown): boolean => typeof value === 'string' && value.includes('{{');

/**
 * Why a task process cannot serve a Context Engine step as Kibana does, or `undefined`:
 * - AI indices that plugins register at setup (`registerAiIndex`) are created in a space when it
 *   first reads them, from a registry that is empty in a process. The one Agent Builder registers is
 *   known; an id that is a template is only known when the step runs.
 * - A custom verifier workflow (`workflow_id`) is run and, when it times out, cancelled with the
 *   workflows management API, which a process does not have. Verifiers given as a template are
 *   only known when the step runs.
 */
export const checkContextEngineStep: WorkflowStepRunCheck = ({ type, config }) => {
  if (!type.startsWith(CONTEXT_ENGINE_STEP_PREFIX)) return undefined;
  const input = (config.with ?? {}) as Record<string, unknown>;

  const aiIndexId = input.ai_index_id;
  if (aiIndexId === agentBuilderDefaultAiIndexId) {
    return `the AI index "${aiIndexId}" is registered by Agent Builder, whose registrations a task process does not have`;
  }
  if (isTemplate(aiIndexId)) {
    return 'ai_index_id is a template, which is only known when the step runs, and might name an AI index that plugins register in Kibana';
  }

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
