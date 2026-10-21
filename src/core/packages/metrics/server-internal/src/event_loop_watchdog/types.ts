/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { LogMeta } from '@kbn/logging';
import type { KibanaExecutionContext } from '@kbn/core-execution-context-common';
import type { AdmissionLimits } from './admission';

export const WATCHDOG_WORKER_NAME = 'event-loop-watchdog';

// Hardcoded PoC settings.
export const HEARTBEAT_INTERVAL_MS = 50;
export const BLOCK_THRESHOLD_MS = 200;
export const POLL_INTERVAL_MS = 25;
/** A block is profiled once it has lasted this long: egregious blocks only, not jitter. */
export const PROFILE_AFTER_MS = 2_000;
/** A profile stops when its block ends, or after this long. */
export const MAX_PROFILE_MS = 10_000;
/** At most one profile per this interval (counted from its start). */
export const PROFILE_COOLDOWN_MS = 60_000;
/** 99 Hz, as Datadog's tracer: avoids sampling in lockstep with 10ms timers. */
export const SAMPLING_INTERVAL_US = Math.round(1_000_000 / 99);
/** Files are written for blocks among this many largest written so far... */
export const MAX_LARGEST_FILES = 10;
/** ...exceeding the smallest of them by this factor once ranked (records: the largest). */
export const MIN_BLOCK_GROWTH = 1.25;
/** Files written for ranking; the rest of the cap is reserved for records. */
export const MAX_RANKED_FILES = 70;
/** Safety cap on files written per worker. */
export const MAX_WRITTEN_FILES = 100;
/** Startup blocks are written only for a new largest startup block, at most this many. */
export const MAX_STARTUP_FILES = 10;
/** Kibana is considered running this long after its overall status first becomes available... */
export const RUNNING_GRACE_MS = 30_000;
/** ...or this long after the watchdog service starts, whichever comes first. */
export const RUNNING_FALLBACK_MS = 5 * 60_000;
/** Sampling of the current execution context starts once a block has lasted this long. */
export const SAMPLE_AFTER_MS = 500;
/** Cadence of `Runtime.evaluate` samples, once a block is being sampled. */
export const SAMPLE_INTERVAL_MS = 250;
/** Safety cap on samples kept per block; only bounds memory for a pathologically long block. */
export const MAX_SAMPLES_PER_BLOCK = 2_400;
/**
 * Bounded wait, once a block ends, for the most recently posted `Runtime.evaluate` reply to
 * arrive before reporting attribution: it was posted while blocked, and its reply is delivered
 * over the worker's own message port, which only gets a chance to run once the block itself is
 * detected as over, typically a tick or two behind the reply actually landing on the main thread.
 */
export const SAMPLE_LANDING_GRACE_MS = 100;

/** Startup blocks are expected (and seen before serving traffic); they get their own budget. */
export type Phase = 'startup' | 'running';

/**
 * Slots of the BigInt64Array shared by the main thread and the worker. Times are process-wide
 * monotonic microseconds (`process.hrtime`).
 */
export const Slot = {
  /** Stamped by the main thread every heartbeat interval. */
  heartbeat: 0,
  /** When Kibana was considered running (0 while starting up); blocks before it are startup. */
  runningSince: 1,
} as const;
export const SLOT_COUNT = 2;

export const monotonicUs = (): number => Number(process.hrtime.bigint() / 1000n);

export interface WatchdogWorkerData {
  shared: SharedArrayBuffer;
  sanitizeRoot: string;
  diagnosticDir?: string;
  admissionLimits?: AdmissionLimits;
  /** Overrides of the profiling thresholds, for tests. */
  profiling?: { afterMs: number; maxMs: number; cooldownMs: number };
}

export interface WatchdogLogMeta extends LogMeta {
  kibana: { event_loop_watchdog: Record<string, unknown> };
}

export interface LogMessage {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  meta?: WatchdogLogMeta;
}
export type WorkerToMainMessage = LogMessage;
/** The main thread sends nothing: the worker profiles it through an inspector session. */
export type MainToWorkerMessage = never;

/**
 * One `Runtime.evaluate` of the main thread's current execution context, dispatched while it was
 * blocked. `landedAtUs` is undefined while the sample is still in flight (e.g. a long native call
 * delays it): such a sample's time is opaque and never credited to the context it eventually
 * names, since that context may only have started after the block did.
 */
export interface ContextSample {
  postedAtUs: number;
  /** Main thread clock (the same one the heartbeat uses) when the evaluate landed. */
  landedAtUs?: number;
  context: KibanaExecutionContext | null;
  /** The accessor was not installed, or the evaluate failed. */
  missing: boolean;
}

export interface ContextObservation {
  /** Stable key for the full context chain (`type/name/id`, through `child`); see `contextKey`. */
  key: string;
  context: KibanaExecutionContext;
  observedMs: number;
  samples: number;
}

/**
 * Partition of a block's timeline. `unsampledMs + opaqueMs + noContextMs +
 * sum(perContext.observedMs)` equals `blockedMs`. Only `perContext` time is ever credited to a
 * context: see `partitionBlock` in `context_sampler.ts`.
 */
export interface BlockAttribution {
  blockedMs: number;
  /** `unsampledPrefixMs + unsampledTailMs`. */
  unsampledMs: number;
  /** From the start of the block to the first evaluate being posted. */
  unsampledPrefixMs: number;
  /** After the last landing, beyond the one interval credited to it (only when sampling stopped). */
  unsampledTailMs: number;
  /** Between posting an evaluate and it landing: uninterruptible native work, owner unknown. */
  opaqueMs: number;
  /** Part of `opaqueMs` bounded on both sides by the same context. Reported, never credited. */
  inferredMs: number;
  /** Sampled intervals where no execution context was current. */
  noContextMs: number;
  samples: number;
  missingAccessor: boolean;
  perContext: ContextObservation[];
}
