/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaExecutionContext } from '@kbn/core-execution-context-common';
import {
  SAMPLE_INTERVAL_MS,
  POLL_INTERVAL_MS,
  type BlockAttribution,
  type ContextObservation,
  type ContextSample,
} from './types';

export interface PartitionOpts {
  sampleIntervalMs: number;
  pollIntervalMs: number;
}

const DEFAULT_OPTS: PartitionOpts = {
  sampleIntervalMs: SAMPLE_INTERVAL_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
};

const toMs = (us: number) => us / 1000;

/**
 * Stable key for a context chain (`type/name/id`, through `child`), so two samples naming
 * the same execution context (but freshly deserialised from different `Runtime.evaluate` calls)
 * group together. Does not distinguish two separate executions of the same context (e.g. two
 * back-to-back task runs with the same type/id are merged).
 */
export const contextKey = (context: KibanaExecutionContext): string => {
  const { type = '', name = '', id = '', child } = context;
  const level = `${type}/${name}/${id}`;
  return child ? `${level}>${contextKey(child)}` : level;
};

/**
 * Partitions a block's timeline (monotonic microseconds) from the evaluates dispatched while it
 * lasted. A sample is exact about the instant it lands and about nothing before it: an evaluate
 * posted during one long native call lands only when that call returns, and may then name a
 * different context that happens to run next. That interval is therefore opaque and never
 * credited.
 *
 * - `[blockStart, firstPost)` is unsampled.
 * - `[post, landing)` of each sample is opaque. A sample still in flight at the end of the block
 *   contributes `[post, blockEnd)`.
 * - `[landing_i, post_{i+1})` is credited to sample i's context. After the last landing at most
 *   one sample interval (plus one poll) is credited, the window in which a re-post was due; the
 *   rest is unsampled.
 */
export const partitionBlock = (
  startedAtUs: number,
  endedAtUs: number,
  samples: ContextSample[],
  opts: PartitionOpts = DEFAULT_OPTS
): BlockAttribution => {
  const blockedUs = Math.max(0, endedAtUs - startedAtUs);
  const tailCapUs = (opts.sampleIntervalMs + opts.pollIntervalMs) * 1000;
  const clamp = (us: number) => Math.min(Math.max(us, startedAtUs), endedAtUs);

  let prefixUs = 0;
  let tailUs = 0;
  let opaqueUs = 0;
  let inferredUs = 0;
  let noContextUs = 0;
  const perContext = new Map<string, ContextObservation>();

  if (samples.length === 0) {
    prefixUs = blockedUs;
  } else {
    prefixUs = clamp(samples[0].postedAtUs) - startedAtUs;
  }

  let previousLandedKey: string | undefined;
  samples.forEach((sample, i) => {
    const postedUs = clamp(sample.postedAtUs);
    if (sample.landedAtUs === undefined) {
      opaqueUs += endedAtUs - postedUs;
      return;
    }
    const landedUs = clamp(sample.landedAtUs);
    const opaqueSpanUs = Math.max(0, landedUs - postedUs);
    opaqueUs += opaqueSpanUs;
    const key = sample.context ? contextKey(sample.context) : undefined;
    if (key && previousLandedKey && previousLandedKey === key) {
      inferredUs += opaqueSpanUs;
    }
    previousLandedKey = key;

    const next = samples[i + 1];
    let creditEndUs: number;
    if (next) {
      creditEndUs = Math.max(landedUs, clamp(next.postedAtUs));
    } else {
      creditEndUs = Math.min(endedAtUs, landedUs + tailCapUs);
      tailUs += endedAtUs - creditEndUs;
    }
    const creditUs = creditEndUs - landedUs;

    if (!sample.context || !key) {
      noContextUs += creditUs;
      return;
    }
    const existing = perContext.get(key) ?? {
      key,
      context: sample.context,
      observedMs: 0,
      samples: 0,
    };
    existing.observedMs += toMs(creditUs);
    existing.samples += 1;
    perContext.set(key, existing);
  });

  return {
    blockedMs: toMs(blockedUs),
    unsampledMs: toMs(prefixUs + tailUs),
    unsampledPrefixMs: toMs(prefixUs),
    unsampledTailMs: toMs(tailUs),
    opaqueMs: toMs(opaqueUs),
    inferredMs: toMs(inferredUs),
    noContextMs: toMs(noContextUs),
    samples: samples.length,
    missingAccessor: samples.some((sample) => sample.missing),
    perContext: [...perContext.values()].sort((a, b) => b.observedMs - a.observedMs),
  };
};

/** Single-line, human-readable form of a block's context attribution. */
export const formatAttribution = (attribution: BlockAttribution): string => {
  const { perContext, samples, opaqueMs, noContextMs, blockedMs, unsampledMs } = attribution;
  if (perContext.length === 0) {
    return samples === 0
      ? 'no execution context was sampled'
      : 'no execution context was current while sampled';
  }
  const [top] = perContext;
  const { type = 'unknown', name = 'unknown', id } = top.context;
  const idPart = id ? ` id=${id}` : '';
  const sampledMs = blockedMs - unsampledMs;
  const notes: string[] = [];
  if (opaqueMs > 0) notes.push(`${Math.round(opaqueMs)}ms opaque`);
  if (noContextMs > 0) notes.push(`${Math.round(noContextMs)}ms outside any context`);
  const suffix = notes.length ? ` (${notes.join(', ')})` : '';
  return (
    `${type} "${name}"${idPart} held ~${Math.round(top.observedMs)}ms of ` +
    `~${Math.round(sampledMs)}ms sampled${suffix}`
  );
};
