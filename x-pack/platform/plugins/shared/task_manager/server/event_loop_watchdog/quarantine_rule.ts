/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  MIN_QUARANTINE_SAMPLES,
  SAMPLE_INTERVAL_MS,
  type ContextSample,
  type QuarantineDecision,
} from './types';

export interface QuarantineRuleOpts {
  nowUs: number;
  blockStartUs: number;
  flagThresholdMs: number;
  /** Process CPU time over the block's wall time so far. */
  cpuRatio: number;
  minCpuRatio: number;
  sampleIntervalMs?: number;
  minSamples?: number;
}

/**
 * PoC only: decides whether the blocking run should be quarantined right now, while the block is
 * still going. Unlike the flag rule (decided once a block ends, from its full timeline), this
 * runs mid-block so the worker can persist the quarantine before a liveness probe can kill the
 * process. No stack gate: quarantining only flips a status, it never touches the main thread, so
 * it carries none of termination's risk of leaving Node in a broken state.
 */
export const decideQuarantine = (
  samples: ContextSample[],
  {
    nowUs,
    blockStartUs,
    flagThresholdMs,
    cpuRatio,
    minCpuRatio,
    sampleIntervalMs = SAMPLE_INTERVAL_MS,
    minSamples = MIN_QUARANTINE_SAMPLES,
  }: QuarantineRuleOpts
): QuarantineDecision => {
  if ((nowUs - blockStartUs) / 1000 < flagThresholdMs) {
    return { quarantine: false, reason: 'below-threshold' };
  }
  const landed = samples.filter((sample) => sample.landedAtUs !== undefined);
  if (landed.length < minSamples) return { quarantine: false, reason: 'too-few-samples' };
  if (landed.some((sample) => sample.missing || !sample.task)) {
    return { quarantine: false, reason: 'no-context' };
  }
  const [first] = landed;
  if (landed.some((sample) => sample.task!.executionUuid !== first.task!.executionUuid)) {
    return { quarantine: false, reason: 'multiple-contexts' };
  }
  const latest = landed[landed.length - 1];
  if (nowUs - latest.landedAtUs! > 2 * sampleIntervalMs * 1000) {
    return { quarantine: false, reason: 'stale-sample' };
  }
  if (cpuRatio < minCpuRatio) return { quarantine: false, reason: 'cpu-starved' };
  return { quarantine: true, task: latest.task! };
};
