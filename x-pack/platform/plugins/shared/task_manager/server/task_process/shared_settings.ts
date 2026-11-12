/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SerializedValue } from './settings';

const inventoryPaths = [
  ['spacesRuntime', 'features'],
  ['alertingAuthorizationRuntime', 'features'],
  ['ruleDataViewsCapabilities', 'features'],
  ['ml', 'spaces', 'features'],
  ['mlWorkflowRuntime', 'moduleFiles'],
  ['mlAgentBuilder', 'moduleFiles'],
  ['ml', 'moduleFiles'],
] as const;

/** Ships structurally identical feature inventories and ML files once per init snapshot. */
export const deduplicateSettings = (
  settings: Record<string, SerializedValue>
): {
  settings: Record<string, SerializedValue>;
  sharedSettings: Record<string, SerializedValue>;
} => {
  const copies = new Map<string, { value: SerializedValue; paths: readonly string[][] }>();
  for (const path of inventoryPaths) {
    let value: SerializedValue | undefined = settings;
    for (const key of path) {
      value =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, SerializedValue>)[key]
          : undefined;
    }
    if (value === undefined) continue;
    const serialized = JSON.stringify(value);
    const existing = copies.get(serialized);
    copies.set(serialized, { value, paths: [...(existing?.paths ?? []), [...path]] });
  }
  const packed = { ...settings };
  const sharedSettings: Record<string, SerializedValue> = {};
  for (const { value, paths } of copies.values()) {
    if (paths.length < 2) continue;
    const key = `inventory-${Object.keys(sharedSettings).length}`;
    sharedSettings[key] = value;
    for (const path of paths) {
      let parent: Record<string, SerializedValue> = packed;
      for (const segment of path.slice(0, -1)) {
        const child = parent[segment];
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          throw new Error(`Invalid shared settings path: ${path.join('.')}`);
        }
        const next = { ...child };
        parent[segment] = next;
        parent = next;
      }
      parent[path[path.length - 1]] = { __kind: 'sharedSetting', key };
    }
  }
  return { settings: packed, sharedSettings };
};
