/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isTerminationSafeStack } from './stack_gate';
import {
  MIN_TERMINATION_SAMPLES,
  SAMPLE_INTERVAL_MS,
  type ContextSample,
  type CurrentTaskContext,
  type TerminationReason,
} from './types';

export interface TerminationRuleOpts {
  nowUs: number;
  blockStartUs: number;
  flagThresholdMs: number;
  /** Process CPU time over the block's wall time so far. */
  cpuRatio: number;
  minCpuRatio: number;
  sampleIntervalMs?: number;
  minSamples?: number;
}

export type TerminationDecision =
  | { terminate: true; task: CurrentTaskContext; stack: string }
  | { terminate: false; reason: TerminationReason };

/**
 * Decides whether the blocking run should be terminated right now. Stricter than the flag rule: a
 * wrong flag is a log line, a wrong termination drops work. Every sample that landed must name the
 * same run, the latest must be fresh (so JavaScript is still being interrupted, not a native call),
 * and the blocked stack must be one Node survives a termination in.
 */
export const decideTermination = (
  samples: ContextSample[],
  {
    nowUs,
    blockStartUs,
    flagThresholdMs,
    cpuRatio,
    minCpuRatio,
    sampleIntervalMs = SAMPLE_INTERVAL_MS,
    minSamples = MIN_TERMINATION_SAMPLES,
  }: TerminationRuleOpts
): TerminationDecision => {
  if ((nowUs - blockStartUs) / 1000 < flagThresholdMs) {
    return { terminate: false, reason: 'below-threshold' };
  }
  const landed = samples.filter((sample) => sample.landedAtUs !== undefined);
  if (landed.length < minSamples) return { terminate: false, reason: 'too-few-samples' };
  if (landed.some((sample) => sample.missing || !sample.task)) {
    return { terminate: false, reason: 'no-context' };
  }
  const [first] = landed;
  if (landed.some((sample) => sample.task!.executionUuid !== first.task!.executionUuid)) {
    return { terminate: false, reason: 'multiple-contexts' };
  }
  const latest = landed[landed.length - 1];
  if (nowUs - latest.landedAtUs! > 2 * sampleIntervalMs * 1000) {
    return { terminate: false, reason: 'stale-sample' };
  }
  // The stack is judged before the CPU ratio: it is the cheaper, load independent refusal.
  if (!latest.stack) return { terminate: false, reason: 'no-stack' };
  if (!isTerminationSafeStack(latest.stack, latest.stackTruncated).safe) {
    return { terminate: false, reason: 'unsafe-stack' };
  }
  if (cpuRatio < minCpuRatio) return { terminate: false, reason: 'cpu-starved' };
  return { terminate: true, task: latest.task!, stack: latest.stack };
};
