/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/*
 * Runs in the watchdog worker thread: detects blocks from the main thread's heartbeat and, when a
 * block is egregious, profiles the main thread through an inspector session. Inspector commands
 * run on the main thread through V8 interrupts, so profiling can start while it is blocked. The
 * profile arrives parsed in this thread, which summarises and writes it. All logs are posted to
 * the main thread's logger.
 *
 * Independently, from a lower threshold, a second inspector session samples which execution
 * context (e.g. a Task Manager task run) is current on the main thread, the same way: an
 * interrupt lands inside whatever synchronous JavaScript is running. The resulting attribution is
 * folded into the block's own log line, not profiling-specific, so it also names short blocks that
 * never reach the profiling threshold.
 */

import Fs from 'node:fs/promises';
import { Session } from 'node:inspector';
import Os from 'node:os';
import Path from 'node:path';
import type { MessagePort } from 'node:worker_threads';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { KibanaExecutionContext } from '@kbn/core-execution-context-common';
import { EXECUTION_CONTEXT_INSPECTOR_ACCESSOR_KEY } from '@kbn/core-execution-context-common';
import { WriteAdmission, type AdmissionLimits } from './admission';
import { BlockDetector, type DetectedBlock } from './block_detector';
import { formatAttribution, partitionBlock } from './context_sampler';
import {
  formatSummary,
  summarizeProfile,
  type CpuProfile,
  type ProfileOutcome,
} from './profile_summary';
import {
  BLOCK_THRESHOLD_MS,
  MAX_PROFILE_MS,
  MAX_SAMPLES_PER_BLOCK,
  MAX_STARTUP_FILES,
  POLL_INTERVAL_MS,
  PROFILE_AFTER_MS,
  PROFILE_COOLDOWN_MS,
  SAMPLE_AFTER_MS,
  SAMPLE_INTERVAL_MS,
  SAMPLE_LANDING_GRACE_MS,
  SAMPLING_INTERVAL_US,
  Slot,
  monotonicUs,
  type ContextSample,
  type LogMessage,
  type Phase,
  type WatchdogWorkerData,
} from './types';

/**
 * Evaluated on the main thread. `at` is the main thread's own clock (the same `process.hrtime`
 * the heartbeat uses), so the delay between posting and landing is measured where the evaluate
 * actually ran. The accessor is read by key, not imported: a worker thread's `Runtime.evaluate`
 * string runs in the main thread's realm, which has its own `Symbol.for` registry.
 */
const SAMPLE_EXPRESSION = `(() => {
  const f = globalThis[Symbol.for('${EXECUTION_CONTEXT_INSPECTOR_ACCESSOR_KEY}')];
  return {
    at: Number(process.hrtime.bigint() / 1000n),
    context: typeof f === 'function' ? f() : null,
    missing: typeof f !== 'function',
  };
})()`;

/** The part of `node:inspector`'s `Session` used here. */
export interface InspectorSession {
  connectToMainThread(): void;
  post(
    method: string,
    params: object,
    callback: (error: Error | null, result?: object) => void
  ): void;
  disconnect(): void;
  /**
   * Optional: `node:inspector`'s real `Session` extends `EventEmitter` and delivers inspector
   * notifications (e.g. `Runtime.executionContextCreated`) this way. Omitted by simpler test
   * doubles that only exercise request/response commands.
   */
  on?(event: string, listener: (message: { params: Record<string, unknown> }) => void): void;
}

/** Leads with the phase and the zero-padded block duration, so sorted listings surface the worst. */
const fileName = (phase: Phase, blockedMs: number, date: Date) =>
  `event-loop-block-${phase}-${String(Math.round(blockedMs)).padStart(6, '0')}ms-${date
    .toISOString()
    .replace(/[:.]/g, '-')}-${Os.hostname()}-${process.pid}.cpuprofile`;

/** Startup blocks are written only for a new largest startup block. */
const STARTUP_ADMISSION_LIMITS: AdmissionLimits = {
  maxLargest: 1,
  minGrowth: 1,
  maxRanked: 0,
  maxFiles: MAX_STARTUP_FILES,
};

interface Capture {
  session: InspectorSession;
  /** Monotonic µs when the block started (its last heartbeat). */
  blockStartUs: number;
  requestedAtUs: number;
  profilerStartMs?: number;
  stopping: boolean;
}

interface Sampling {
  /** Monotonic µs when the block started (its last heartbeat); seeded as soon as one begins. */
  startUs: number;
  samples: ContextSample[];
  session?: InspectorSession;
  sessionFailed: boolean;
  inFlight: boolean;
  lastLandedUs: number;
  /**
   * V8 execution contexts known to exist on the main thread (e.g. a sandboxed `vm.Context`
   * alongside the default one). `Runtime.evaluate` without a `contextId` only reaches the
   * default context, so the accessor is looked up in every known context and the first that
   * has it wins. Populated from `Runtime.executionContextCreated`, backfilled for existing
   * contexts as soon as `Runtime.enable` succeeds.
   */
  contextIds: number[];
}

export const runWatchdogWorker = (
  port: MessagePort,
  data: WatchdogWorkerData,
  createSession: () => InspectorSession = () => new Session()
): void => {
  const {
    sanitizeRoot,
    diagnosticDir,
    profiling: { afterMs, maxMs, cooldownMs } = {
      afterMs: PROFILE_AFTER_MS,
      maxMs: MAX_PROFILE_MS,
      cooldownMs: PROFILE_COOLDOWN_MS,
    },
  } = data;
  const shared = new BigInt64Array(data.shared);
  const detector = new BlockDetector(BLOCK_THRESHOLD_MS);
  /** Phase at `atUs`: running once the main thread has marked it. */
  const phaseAt = (atUs: number): Phase => {
    const runningSince = Number(Atomics.load(shared, Slot.runningSince));
    return runningSince > 0 && atUs >= runningSince ? 'running' : 'startup';
  };
  const admissions: Record<Phase, WriteAdmission> = {
    startup: new WriteAdmission(STARTUP_ADMISSION_LIMITS),
    running: new WriteAdmission(data.admissionLimits),
  };
  const epochOffsetUs =
    Math.round((performance.timeOrigin + performance.now()) * 1000) - monotonicUs();
  const log = (level: LogMessage['level'], message: string, meta?: LogMessage['meta']) =>
    port.postMessage({ type: 'log', level, message, meta } satisfies LogMessage);

  let capture: Capture | undefined;
  let lastCaptureAtUs = -Infinity;
  let profiled = 0;
  let sampling: Sampling | undefined;

  const post = <T>(session: InspectorSession, method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) =>
      session.post(method, params, (error, result) =>
        error ? reject(error) : resolve(result as T)
      )
    );

  const openSamplingSession = (current: Sampling) => {
    let session: InspectorSession | undefined;
    try {
      session = createSession();
      session.connectToMainThread();
      current.session = session;
      // Existing contexts are backfilled as soon as this succeeds; see `Sampling.contextIds`.
      session.on?.('Runtime.executionContextCreated', (message) => {
        const id = (message.params.context as { id?: number } | undefined)?.id;
        if (typeof id === 'number') current.contextIds.push(id);
      });
      // The first sample waits for this: posting it any earlier would race the backfill above,
      // evaluating only in the default context even when the real one is some other context.
      session.post('Runtime.enable', {}, () => {
        if (sampling === current) postContextSample(current);
      });
    } catch (error) {
      current.sessionFailed = true;
      log('warn', `Failed to open a context-sampling session: ${error.message}`);
      try {
        session?.disconnect();
      } catch {
        // never connected
      }
    }
  };

  interface Evaluated {
    at: number;
    context: KibanaExecutionContext | null;
    missing: boolean;
  }

  /** Evaluates `SAMPLE_EXPRESSION` in a single context, resolving to its parsed reply. */
  const evaluateIn = (session: InspectorSession, contextId?: number) =>
    new Promise<Evaluated>((resolve) => {
      try {
        session.post(
          'Runtime.evaluate',
          { expression: SAMPLE_EXPRESSION, returnByValue: true, silent: true, contextId },
          (error, result) => {
            const value = (result as { result?: { value?: Record<string, unknown> } } | undefined)
              ?.result?.value;
            if (error || !value || typeof value.at !== 'number') {
              resolve({ at: monotonicUs(), context: null, missing: true });
            } else {
              resolve({
                at: value.at as number,
                context: (value.context as KibanaExecutionContext | null) ?? null,
                missing: value.missing === true,
              });
            }
          }
        );
      } catch {
        resolve({ at: monotonicUs(), context: null, missing: true });
      }
    });

  const postContextSample = (current: Sampling) => {
    const { session } = current;
    if (!session) return;
    const sample: ContextSample = { postedAtUs: monotonicUs(), context: null, missing: false };
    current.samples.push(sample);
    current.inFlight = true;
    // Evaluating without a `contextId` only reaches the default context; every other known
    // context (e.g. a sandboxed `vm.Context`) is tried too, and the first with a context wins.
    const contextIds: Array<number | undefined> = [undefined, ...current.contextIds];
    Promise.all(contextIds.map((contextId) => evaluateIn(session, contextId))).then((results) => {
      // The block ended (and the session was disconnected) before this reply: ignore it.
      if (sampling !== current) return;
      const landed = results.find((result) => !result.missing) ?? results[0];
      sample.landedAtUs = landed.at;
      sample.context = landed.context;
      sample.missing = landed.missing;
      current.lastLandedUs = sample.landedAtUs;
      current.inFlight = false;
    });
  };

  const endCapture = (current: Capture) => {
    try {
      current.session.disconnect(); // also stops a profile that is still running
    } catch {
      // already disconnected
    }
    if (capture === current) capture = undefined;
  };

  const startCapture = (blockStartUs: number) => {
    const session = createSession();
    session.connectToMainThread();
    const current: Capture = {
      session,
      blockStartUs,
      requestedAtUs: monotonicUs(),
      stopping: false,
    };
    capture = current;
    lastCaptureAtUs = current.requestedAtUs;
    // Pipelined: the main thread runs them in order at its next interrupt check.
    Promise.all([
      post(session, 'Profiler.enable'),
      post(session, 'Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US }),
      post(session, 'Profiler.start'),
    ])
      .then(() => {
        current.profilerStartMs = (monotonicUs() - current.requestedAtUs) / 1000;
      })
      .catch((error) => {
        log('warn', `Failed to start profiling an event loop block: ${error.message}`);
        endCapture(current);
      });
  };

  const onProfile = async (current: Capture, profile: CpuProfile, blockedMs: number) => {
    const summary = summarizeProfile(profile, sanitizeRoot);
    const phase = phaseAt(current.blockStartUs);
    const block = {
      blockedMs,
      profiledAfterMs: (current.requestedAtUs - current.blockStartUs) / 1000,
      profilerStartMs: current.profilerStartMs,
    };
    let outcome: ProfileOutcome = { notWritten: 'no diagnostic directory' };
    if (summary.samples === 0) {
      outcome = { notWritten: 'no busy samples (the block ended as profiling started)' };
    } else if (diagnosticDir) {
      const admitted = admissions[phase].admit(blockedMs);
      if (admitted.write) {
        // Files there are collected a minute after their last change: no partial uploads.
        const file = Path.join(diagnosticDir, fileName(phase, blockedMs, new Date()));
        await Fs.writeFile(file, JSON.stringify(profile));
        outcome = { file };
      } else {
        outcome = { notWritten: admitted.reason };
      }
    }
    // Written profiles are the ones to look at; the others still show where blocks come from.
    log('file' in outcome ? 'warn' : 'info', formatSummary(summary, block, ++profiled, outcome), {
      tags: ['event-loop-watchdog'],
      kibana: {
        event_loop_watchdog: {
          profile: { ...summary, ...block, profiled, phase, ...outcome },
        },
      },
    });
  };

  const stopCapture = (current: Capture, blockedMs: number) => {
    if (current.stopping) return;
    current.stopping = true;
    post<{ profile: CpuProfile }>(current.session, 'Profiler.stop')
      .then(({ profile }) => onProfile(current, profile, blockedMs))
      .catch((error) =>
        log('error', `Failed to process an event loop block profile: ${error.message}`)
      )
      .finally(() => endCapture(current));
  };

  const reportBlock = (block: DetectedBlock, startUs: number, sampled: Sampling | undefined) => {
    if (sampled?.session) {
      try {
        sampled.session.disconnect();
      } catch {
        // already disconnected
      }
    }
    if (!block.report) return;
    // Only report attribution when sampling actually started: a block that ended before reaching
    // the sampling threshold has nothing to say, which differs from having sampled and found
    // nothing current.
    const attribution = sampled?.session
      ? partitionBlock(startUs, startUs + block.blockedMs * 1000, sampled.samples)
      : undefined;
    const blockedMs = Math.round(block.blockedMs);
    log(
      'warn',
      `Event loop blocked for ~${blockedMs}ms${
        attribution ? `; ${formatAttribution(attribution)}` : ''
      }${block.suppressedBlocks ? `; ${block.suppressedBlocks} earlier blocks not reported` : ''}`,
      {
        tags: ['event-loop-watchdog'],
        kibana: {
          event_loop_watchdog: {
            blockedMs,
            startedAt: new Date((startUs + epochOffsetUs) / 1000).toISOString(),
            phase: phaseAt(startUs),
            suppressedBlocks: block.suppressedBlocks,
            ...(attribution ? { attribution } : {}),
          },
        },
      }
    );
  };

  const onBlock = (block: DetectedBlock) => {
    const startUs = block.startedAt * 1000;
    if (capture && !capture.stopping && capture.blockStartUs === startUs) {
      stopCapture(capture, block.blockedMs);
    }

    const sampled = sampling && sampling.startUs === startUs ? sampling : undefined;
    sampling = undefined;
    if (sampled?.inFlight) {
      // The last evaluate was posted while still blocked; its reply is delivered over this
      // worker's own message port, which only gets a chance to run once the block itself is
      // detected as over. Give it a brief, bounded chance to land so the report names what was
      // actually current right up to the end, rather than one sample behind.
      setTimeout(() => reportBlock(block, startUs, sampled), SAMPLE_LANDING_GRACE_MS);
    } else {
      reportBlock(block, startUs, sampled);
    }
  };

  const poll = () => {
    const nowMs = monotonicUs() / 1000;
    const block = detector.poll(nowMs, Number(Atomics.load(shared, Slot.heartbeat)) / 1000);
    if (block) onBlock(block);
    const { blockedSince } = detector;
    if (blockedSince === undefined) {
      sampling = undefined;
      return;
    }

    if (!sampling) {
      sampling = {
        startUs: blockedSince * 1000,
        samples: [],
        sessionFailed: false,
        inFlight: false,
        lastLandedUs: 0,
        contextIds: [],
      };
    }
    const nowUs = monotonicUs();
    if (!sampling.session && !sampling.sessionFailed && nowMs - blockedSince >= SAMPLE_AFTER_MS) {
      openSamplingSession(sampling); // posts the first sample itself, once contexts are known
    } else if (
      sampling.session &&
      !sampling.sessionFailed &&
      !sampling.inFlight &&
      sampling.samples.length < MAX_SAMPLES_PER_BLOCK &&
      nowUs - sampling.lastLandedUs >= SAMPLE_INTERVAL_MS * 1000
    ) {
      postContextSample(sampling);
    }

    if (
      !capture &&
      nowMs - blockedSince >= afterMs &&
      nowMs * 1000 - lastCaptureAtUs >= cooldownMs * 1000
    ) {
      startCapture(blockedSince * 1000);
    } else if (
      capture &&
      capture.blockStartUs === blockedSince * 1000 &&
      nowMs * 1000 - capture.requestedAtUs >= maxMs * 1000
    ) {
      // still blocked: keep what was sampled so far
      stopCapture(capture, nowMs - blockedSince);
    }
  };

  const timer = setInterval(poll, POLL_INTERVAL_MS);
  port.on('close', () => {
    clearInterval(timer);
    if (capture) endCapture(capture);
    try {
      sampling?.session?.disconnect();
    } catch {
      // already disconnected
    }
  });
};

if (!isMainThread && parentPort) {
  runWatchdogWorker(parentPort, workerData as WatchdogWorkerData);
}
