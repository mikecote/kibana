/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AiIndexRegistry } from '../ai_indices/registry';

export const CONTEXT_ENGINE_MANAGED_INDICES_SETTINGS_ID = 'contextEngineManagedAiIndices';

export interface ContextEngineManagedIndicesSettings {
  registrations: ReturnType<AiIndexRegistry['getRegistrations']>;
}

/** Restores the managed AI indices registered in Kibana for a workflow execution. */
export const createTaskProcessAiIndexRegistry = (
  settings: ContextEngineManagedIndicesSettings | undefined
): AiIndexRegistry => {
  if (!settings) throw new Error('The task process did not receive the managed AI index registry');
  const registry = new AiIndexRegistry();
  for (const { id, properties } of settings.registrations) registry.register(id, properties);
  registry.freeze();
  return registry;
};
