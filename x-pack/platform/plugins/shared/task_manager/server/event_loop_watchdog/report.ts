/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CurrentTaskContext, EventLoopBlockReport, QuarantineNotice } from './types';

const task = (t: CurrentTaskContext) => `${t.taskType} "${t.taskId}"`;

export const formatBlockReport = ({
  blockedMs,
  flag,
  attribution,
  cpuRatio,
}: EventLoopBlockReport) => {
  const base = `Event loop blocked for ~${Math.round(blockedMs)}ms`;
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

/** PoC only: written straight to stderr once the Elasticsearch write settles. */
export const formatQuarantineNotice = (notice: QuarantineNotice) =>
  `Quarantining ${task(notice)} (execution ${notice.executionUuid}), blocked for ` +
  `~${Math.round(notice.blockedMs)}ms` +
  (notice.persisted
    ? ': persisted to Elasticsearch'
    : `: failed to persist to Elasticsearch (${notice.error}); the task run's completion path ` +
      'will fall back to writing it');

/** PoC only: written straight to stderr right before the Elasticsearch write is issued, so a
 * subsequent kill of the process still leaves a trail of what the worker was attempting. */
export const formatQuarantiningNotice = (task_: CurrentTaskContext, blockedMs: number) =>
  `Quarantining ${task(task_)} (execution ${task_.executionUuid}), blocked for ` +
  `~${Math.round(blockedMs)}ms: writing to Elasticsearch`;

/** PoC only: logged on the main thread once it learns of a quarantine the worker decided and (if
 * `persisted`) already wrote, independently and possibly before this log line can run at all. */
export const formatQuarantineLog = (notice: QuarantineNotice) =>
  `Task ${task(notice)} (execution ${notice.executionUuid}) was quarantined after blocking the ` +
  `event loop for ~${Math.round(notice.blockedMs)}ms` +
  (notice.persisted
    ? ' (persisted by the watchdog worker)'
    : ` (the worker failed to persist it: ${notice.error}; falling back to persisting it here)`);
