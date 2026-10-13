/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CurrentTaskContext, EventLoopBlockReport, TerminationNotice } from './types';

const task = (t: CurrentTaskContext) => `${t.taskType} "${t.taskId}"`;

export const formatBlockReport = ({
  blockedMs,
  flag,
  attribution,
  cpuRatio,
  terminated,
  terminationRefused,
}: EventLoopBlockReport) => {
  const base =
    `Event loop blocked for ~${Math.round(blockedMs)}ms` +
    (terminated ? ' (terminated the blocking run)' : '') +
    (terminationRefused ? ` (termination refused: ${terminationRefused})` : '');
  if (flag.flagged) {
    const { evidence } = flag;
    return (
      `${base}; flagged task ${task(flag)} (execution ${flag.executionUuid}) held ` +
      `~${evidence.observedMs}ms of ~${Math.round(
        blockedMs - attribution.unsampledMs
      )}ms sampled ` +
      `(unsampled ${evidence.unsampledMs}ms, opaque ${evidence.opaqueMs}ms, cpu ${evidence.cpuRatio})`
    );
  }
  return `${base} (not attributed: ${flag.reason}; cpu ${Math.round(cpuRatio * 100) / 100})`;
};

/** Written straight to stderr while a block is still going: the main thread cannot log. */
export const formatStillBlockedNotice = (elapsedMs: number, latest: CurrentTaskContext | null) =>
  `Event loop still blocked after ~${Math.round(elapsedMs)}ms` +
  (latest ? `; latest sampled task ${task(latest)}` : '; no task sampled yet');

/** Written straight to stderr when the blocking run is terminated: the main thread cannot log. */
export const formatTerminationNotice = ({ blockedMs, ...notice }: TerminationNotice) =>
  `Terminating ${task(notice)} (execution ${notice.executionUuid}) after the event loop was ` +
  `blocked for ~${Math.round(blockedMs)}ms`;

/** The warning logged on the main thread once the termination is known: carries the blocked stack. */
export const formatTerminationLog = (notice: TerminationNotice) =>
  `${formatTerminationNotice(notice)}. Blocked at:\n${notice.stack}`;
