/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import type { SerializedValue } from './settings';
import type { TaskProcessInit } from './wire';

// Only registration metadata is live-read; mixed configuration and credentials remain inline.
const inventoryPaths = [
  'spacesRuntime.features',
  'alertingAuthorizationRuntime.features',
  'ruleDataViewsCapabilities.features',
  'ml.spaces.features',
  'inferenceFeatures',
  'contextEngineManagedAiIndices',
  'embeddableRuntime',
  'entityStoreRuntime.maintainers',
  'alertingRuleRead.ruleTypes',
  'alertingAuthorizationRuntime.ruleTypes',
  'workflowsManagementRuntime.managedWorkflowPluginIds',
  'significantEvents.registrations',
  'observabilityAgentBuilderRuntime.registrations',
  'observabilityAgentBuilderRuntime.dataProviders',
  'taskManager.scheduling.definitions',
  'taskManager.scheduling.middlewareIds',
] as const;
const assetPaths = [
  'mlWorkflowRuntime.moduleFiles',
  'mlAgentBuilder.moduleFiles',
  'ml.moduleFiles',
];

export const digestValue = (value: SerializedValue): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const inlineShared = (
  value: SerializedValue,
  shared: Record<string, SerializedValue>
): SerializedValue => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((child) => inlineShared(child, shared));
  if (value.__kind === 'sharedSetting' && typeof value.key === 'string') {
    if (!Object.hasOwn(shared, value.key)) throw new Error('Missing shared inventory');
    return shared[value.key];
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, inlineShared(child, shared)])
  );
};

export interface PreparedInit {
  init: Omit<TaskProcessInit, 'kind' | 'authToken' | 'elasticsearch' | 'kibanaVersion'>;
  inventories: Record<string, SerializedValue>;
  content: Record<string, string>;
}

/** Replaces whitelisted live inventories and installed ML files, without moving per-run facts. */
export const prepareLocalInit = (source: PreparedInit['init']): PreparedInit => {
  const settings = inlineShared(source.settings ?? {}, source.sharedSettings ?? {}) as Record<
    string,
    SerializedValue
  >;
  const inventories: Record<string, SerializedValue> = {};
  const content: Record<string, string> = {};
  for (const path of [...inventoryPaths, ...assetPaths]) {
    const segments = path.split('.');
    let parent: Record<string, SerializedValue> = settings;
    for (const segment of segments.slice(0, -1)) {
      const child = parent[segment];
      if (!child || typeof child !== 'object' || Array.isArray(child)) {
        parent = {};
        break;
      }
      parent = child;
    }
    const key = segments[segments.length - 1];
    const value = parent[key];
    if (value === undefined) continue;
    const digest = digestValue(value);
    if (assetPaths.includes(path)) {
      const text = JSON.stringify(value);
      content[digest] = text;
      parent[key] = { __kind: 'content', digest, size: Buffer.byteLength(text) };
    } else {
      // These four paths share Main's global feature registry, as in the inline dedup contract.
      const inventoryKey = path.endsWith('.features') ? `features:${digest}` : path;
      inventories[inventoryKey] = value;
      parent[key] = { __kind: 'inventory', key: inventoryKey, digest };
    }
  }
  const { sharedSettings, parity, ...facts } = source;
  return {
    init: {
      ...facts,
      settings,
      localAuthority: { registrationRevision: digestValue(parity ?? []) },
    },
    inventories,
    content,
  };
};

/** Resolves boot metadata before existing plugin schemas see the settings. */
export const hydrateInventories = (
  init: TaskProcessInit,
  inventories: Record<string, SerializedValue>
): void => {
  const visit = (value: SerializedValue): SerializedValue => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    if (value.__kind === 'inventory' && typeof value.key === 'string') {
      const found = inventories[value.key];
      if (found === undefined || digestValue(found) !== value.digest)
        throw new Error(`Changed or missing inventory: ${value.key}`);
      return found;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
  };
  init.settings = visit(init.settings ?? {}) as Record<string, SerializedValue>;
};
