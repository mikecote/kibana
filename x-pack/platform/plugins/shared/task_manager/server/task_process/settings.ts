/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import moment from 'moment';
import { ByteSizeValue } from '@kbn/config-schema';

/**
 * A validated plugin config as JSON. `JSON.stringify` would turn a `Duration` into an ISO string and
 * lose a `ByteSizeValue`, so the values that are class instances are tagged and rebuilt on the other
 * side, as `es_config.ts` does for the Elasticsearch config.
 */
export type SerializedValue =
  | string
  | number
  | boolean
  | null
  | SerializedValue[]
  | { [key: string]: SerializedValue }
  | { __kind: 'duration'; ms: number }
  | { __kind: 'byteSize'; bytes: number }
  | { __kind: 'date'; iso: string };

const isTagged = (value: unknown): value is { __kind: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { __kind?: unknown }).__kind === 'string';

export const serializeSettings = (value: unknown): SerializedValue => {
  if (value === null || value === undefined) return null;
  if (moment.isDuration(value)) return { __kind: 'duration', ms: value.asMilliseconds() };
  if (value instanceof ByteSizeValue) {
    return { __kind: 'byteSize', bytes: value.getValueInBytes() };
  }
  if (value instanceof Date) return { __kind: 'date', iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(serializeSettings);
  if (value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new Error(`Cannot send a ${value.constructor.name} to a task process`);
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'object': {
      const out: Record<string, SerializedValue> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // Functions and symbols cannot cross the process boundary.
        if (typeof child === 'function' || typeof child === 'symbol') continue;
        if (child === undefined) continue;
        out[key] = serializeSettings(child);
      }
      return out;
    }
    default:
      throw new Error(`Cannot send a ${typeof value} to a task process`);
  }
};

export const reviveSettings = (value: SerializedValue): unknown => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(reviveSettings);
  if (isTagged(value)) {
    switch (value.__kind) {
      case 'duration':
        return moment.duration((value as { ms: number }).ms);
      case 'byteSize':
        return new ByteSizeValue((value as { bytes: number }).bytes);
      case 'date':
        return new Date((value as { iso: string }).iso);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = reviveSettings(child as SerializedValue);
  }
  return out;
};

export const reviveSettingsByPlugin = (
  settings: Record<string, SerializedValue> | undefined
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(settings ?? {}).map(([id, v]) => [id, reviveSettings(v)]));

/** Awaits each plugin's current settings before a task host or dispatch snapshot consumes them. */
export const resolveSettingsByPlugin = async <T>(
  settings: Readonly<Record<string, () => T>>
): Promise<Record<string, Awaited<T>>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(settings).map(async ([id, getSettings]) => [id, await getSettings()] as const)
    )
  );
