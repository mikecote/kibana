/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/*
 * Runs in the watchdog worker thread. Detects blocks from the main thread's heartbeat and, once a
 * block is long enough, samples which task the main thread is running through an inspector
 * session: `Runtime.evaluate` commands run on the main thread through V8 interrupts, so they land
 * inside synchronous JavaScript (loops, regexes) while it is blocked. The session exists only for
 * the duration of a block. When the block ends the worker partitions its timeline, decides whether
 * one task deserves a flag and posts a single report to the main thread.
 */

import { writeSync } from 'node:fs';
import { Session } from 'node:inspector';
import type { MessagePort } from 'node:worker_threads';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BlockDetector, type DetectedBlock } from './block_detector';
import { partitionBlock } from './context_sampler';
import { decideFlag } from './flag_rule';
import { formatStillBlockedNotice, formatTerminationNotice } from './report';
import { decideTermination } from './termination_rule';
import {
  CURRENT_TASK_ACCESSOR,
  DETECT_THRESHOLD_MS,
  IDLE_PROBE,
  MAX_SAMPLES_PER_BLOCK,
  POLL_INTERVAL_MS,
  POST_TERMINATION_CHECK_MS,
  SAMPLE_AFTER_MS,
  SAMPLE_INTERVAL_MS,
  STACK_CAPTURE_LIMIT,
  STACK_KEEP_BOTTOM,
  STACK_KEEP_TOP,
  monotonicUs,
  type ContextSample,
  type CurrentTaskContext,
  type EventLoopBlockReport,
  type TerminationNotice,
  type TerminationReason,
  type WatchdogWorkerData,
  type WorkerToMainMessage,
} from './types';

/** The part of `node:inspector`'s `Session` used here. */
export interface InspectorSession {
  connectToMainThread(): void;
  post(
    method: string,
    params: object,
    callback: (error: Error | null, result?: object) => void
  ): void;
  disconnect(): void;
}

export interface Cadence {
  pollIntervalMs: number;
  detectThresholdMs: number;
  sampleAfterMs: number;
  sampleIntervalMs: number;
}

export const DEFAULT_CADENCE: Cadence = {
  pollIntervalMs: POLL_INTERVAL_MS,
  detectThresholdMs: DETECT_THRESHOLD_MS,
  sampleAfterMs: SAMPLE_AFTER_MS,
  sampleIntervalMs: SAMPLE_INTERVAL_MS,
};

export interface WorkerDeps {
  /** Timing of detection and sampling. Production uses the defaults; tests run faster. */
  cadence?: Cadence;
  createSession?: () => InspectorSession;
  cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
  /** Monotonic microseconds. */
  now?: () => number;
  /** Writes a line that must be visible while the main thread is blocked. */
  writeLine?: (line: string) => void;
}

/**
 * Evaluated on the main thread. `at` is the main thread's own clock (process-wide `hrtime`, the
 * same one the heartbeat uses), so the delay between posting and landing is measured where the
 * evaluate actually ran.
 */
export const SAMPLE_EXPRESSION = `(() => {
  const f = globalThis[Symbol.for('${String(CURRENT_TASK_ACCESSOR.description)}')];
  const probe = Symbol.for('${String(IDLE_PROBE.description)}');
  const idleSinceLastSample = globalThis[probe] === true;
  globalThis[probe] = false;
  setImmediate(() => { globalThis[probe] = true; });
  const limit = Error.stackTraceLimit;
  let stack;
  let stackTruncated = false;
  try {
    Error.stackTraceLimit = ${STACK_CAPTURE_LIMIT} + 3;
    const raw = new Error().stack;
    if (typeof raw === 'string') {
      // The first lines are the error header and this expression's own two frames.
      const frames = raw.split('\\n').slice(3);
      stackTruncated = frames.length >= ${STACK_CAPTURE_LIMIT};
      // The innermost frames name the code, the outermost ones the Node dispatcher it runs under.
      stack = (frames.length > ${STACK_KEEP_TOP + STACK_KEEP_BOTTOM}
        ? [...frames.slice(0, ${STACK_KEEP_TOP}), '    ... ' + (frames.length - ${
  STACK_KEEP_TOP + STACK_KEEP_BOTTOM
}) + ' more frames', ...frames.slice(-${STACK_KEEP_BOTTOM})]
        : frames).join('\\n');
    }
  } catch (e) {
    // A library replaced Error.prepareStackTrace: no stack, which only refuses a termination.
  } finally {
    Error.stackTraceLimit = limit;
  }
  return {
    at: Number(process.hrtime.bigint() / 1000n),
    task: typeof f === 'function' ? f() : null,
    missing: typeof f !== 'function',
    stack,
    stackTruncated,
    idleSinceLastSample,
  };
})()`;

/**
 * Written straight to the stderr file descriptor: `console.error` and `process.stderr.write` in a
 * worker are routed through the main thread, which is exactly what is blocked.
 */
const writeDirectToStderr = (line: string): void => {
  try {
    writeSync(2, `[event-loop-watchdog] ${line}\n`);
  } catch {
    // best effort: reporting must never throw inside the watchdog loop
  }
};

interface BlockState {
  startUs: number;
  detectedAtUs: number;
  cpuAtDetect: NodeJS.CpuUsage;
  samples: ContextSample[];
  session?: InspectorSession;
  sessionFailed: boolean;
  inFlight: boolean;
  lastLandedUs: number;
  lastLiveReportUs: number;
  terminated?: TerminationNotice;
  terminationRefused?: TerminationReason;
}

export const runWatchdogWorker = (
  port: MessagePort,
  data: WatchdogWorkerData,
  {
    cadence = DEFAULT_CADENCE,
    createSession = () => new Session(),
    cpuUsage = (previous) => process.cpuUsage(previous),
    now = monotonicUs,
    writeLine = writeDirectToStderr,
  }: WorkerDeps = {}
): void => {
  const shared = new BigInt64Array(data.shared);
  const detector = new BlockDetector(cadence.detectThresholdMs);
  const epochOffsetUs = Math.round((performance.timeOrigin + performance.now()) * 1000) - now();
  const iso = (us: number) => new Date((us + epochOffsetUs) / 1000).toISOString();
  const post = (message: WorkerToMainMessage) => port.postMessage(message);
  const reportError = (context: string, error: unknown) =>
    post({
      type: 'worker-error',
      message: `${context}: ${error instanceof Error ? error.message : String(error)}`,
    });

  let state: BlockState | undefined;
  /** Set once a termination left the heartbeat dead while JavaScript ran: never terminate again. */
  let terminationsDisabled = false;
  /**
   * When the last termination happened, until its aftermath has been judged. Worker level, not per
   * block: the runner stamps the heartbeat itself when the terminated run ends, which ends the
   * block even if the main thread's timers are dead.
   */
  let terminationWatchAtUs: number | undefined;

  const latestTask = (current: BlockState): CurrentTaskContext | null => {
    for (let i = current.samples.length - 1; i >= 0; i--) {
      if (current.samples[i].task) return current.samples[i].task;
    }
    return null;
  };

  const postSample = (current: BlockState) => {
    const { session } = current;
    if (!session) return;
    const sample: ContextSample = { postedAtUs: now(), task: null, missing: false };
    current.samples.push(sample);
    current.inFlight = true;
    try {
      session.post(
        'Runtime.evaluate',
        { expression: SAMPLE_EXPRESSION, returnByValue: true, silent: true },
        (error, result) => {
          // The block ended (and the session was disconnected) before this reply: ignore it.
          if (state !== current) return;
          const value = (
            result as
              | { result?: { value?: Record<string, unknown> }; exceptionDetails?: unknown }
              | undefined
          )?.result?.value;
          if (error || !value || typeof value.at !== 'number') {
            sample.landedAtUs = now();
            sample.missing = true;
          } else {
            sample.landedAtUs = value.at;
            sample.task = (value.task as CurrentTaskContext | null) ?? null;
            sample.missing = value.missing === true;
            if (typeof value.stack === 'string') sample.stack = value.stack;
            sample.stackTruncated = value.stackTruncated === true;
            sample.idleSinceLastSample = value.idleSinceLastSample === true;
          }
          current.lastLandedUs = sample.landedAtUs;
          current.inFlight = false;
        }
      );
    } catch (error) {
      current.sessionFailed = true;
      current.inFlight = false;
      current.samples.pop();
      reportError('Runtime.evaluate failed', error);
    }
  };

  const openSession = (current: BlockState) => {
    let session: InspectorSession | undefined;
    try {
      session = createSession();
      session.connectToMainThread();
      current.session = session;
    } catch (error) {
      current.sessionFailed = true;
      reportError('connectToMainThread failed', error);
      try {
        session?.disconnect();
      } catch {
        // never connected
      }
    }
  };

  /** Process-wide CPU over the wall time since detection: can exceed 1 with other threads busy. */
  const cpuRatioSince = (current: BlockState, nowUs: number): number => {
    const wallUs = Math.max(1, nowUs - current.detectedAtUs);
    const cpu = cpuUsage(current.cpuAtDetect);
    return Math.round(((cpu.user + cpu.system) / wallUs) * 100) / 100;
  };

  const maybeTerminate = (current: BlockState, nowUs: number) => {
    if (!data.terminateEnabled || current.terminated || !current.session) return;
    if (terminationsDisabled) {
      current.terminationRefused ??= 'terminations-disabled';
      return;
    }
    const decision = decideTermination(current.samples, {
      nowUs,
      blockStartUs: current.startUs,
      flagThresholdMs: data.flagThresholdMs,
      cpuRatio: cpuRatioSince(current, nowUs),
      minCpuRatio: data.minCpuRatio,
      sampleIntervalMs: cadence.sampleIntervalMs,
    });
    if (!decision.terminate) {
      if (decision.reason !== 'below-threshold' && decision.reason !== 'too-few-samples') {
        if (!current.terminationRefused) {
          writeLine(`Not terminating the blocked run (${decision.reason})`);
          current.terminationRefused = decision.reason;
        }
      }
      return;
    }
    // The block may have ended since the poll started: only terminate while it is still going.
    const stalledMs = (nowUs - Number(Atomics.load(shared, 0))) / 1000;
    if (stalledMs < cadence.detectThresholdMs) return;
    current.terminationRefused = undefined;
    const notice: TerminationNotice = {
      ...decision.task,
      blockedMs: (nowUs - current.startUs) / 1000,
      stack: decision.stack,
      atUs: nowUs,
    };
    try {
      // The reply only arrives once the outermost script on the main thread ends: never wait on it.
      current.session.post('Runtime.terminateExecution', {}, () => {});
    } catch (error) {
      current.sessionFailed = true;
      reportError('Runtime.terminateExecution failed', error);
      return;
    }
    current.terminated = notice;
    // The earliest termination still being judged: later ones must not postpone the verdict.
    terminationWatchAtUs ??= nowUs;
    writeLine(formatTerminationNotice(notice));
    post({ type: 'terminated', notice });
  };

  /**
   * Judges the aftermath of a termination, once, a couple of seconds later. If the main thread is
   * running timers again there is no block: all is well. If a block is going on, the samples tell
   * why. An immediate armed by them only runs when the main thread is idle, and an idle main
   * thread whose heartbeat is stale has dead timers, which the stack gate is meant to make
   * impossible: fail safe, never terminate again in this process. A main thread that is busy is a
   * new, unrelated block: keep watching, for a while.
   */
  const checkTerminationAftermath = (nowUs: number) => {
    if (terminationWatchAtUs === undefined) return;
    const sinceUs = nowUs - terminationWatchAtUs;
    if (sinceUs < POST_TERMINATION_CHECK_MS * 1000) return;
    const current = state;
    if (!current) {
      terminationWatchAtUs = undefined;
      return;
    }
    const watchedFromUs = terminationWatchAtUs;
    const idleAfterTermination = current.samples.some(
      (sample) =>
        sample.landedAtUs !== undefined &&
        sample.landedAtUs > watchedFromUs &&
        sample.idleSinceLastSample === true
    );
    if (!idleAfterTermination) {
      if (sinceUs > 10 * POST_TERMINATION_CHECK_MS * 1000) terminationWatchAtUs = undefined;
      return;
    }
    terminationWatchAtUs = undefined;
    terminationsDisabled = true;
    const message =
      'The main thread runs again but its timers are not firing after a termination; ' +
      'terminations are disabled until Kibana restarts. Restart this node.';
    writeLine(`CRITICAL: ${message}`);
    post({ type: 'termination-disabled', message });
  };

  const onBlockEnded = (block: DetectedBlock, nowUs: number) => {
    const current = state;
    state = undefined;
    // `monotonicUs()` is an integer: rounding undoes the millisecond float round trip.
    const startUs = Math.round(block.startedAt * 1000);
    const endUs = Math.round(block.endedAt * 1000);
    const cpuRatio = current ? cpuRatioSince(current, nowUs) : 0;

    const attribution = partitionBlock(startUs, endUs, current?.samples ?? [], {
      sampleIntervalMs: cadence.sampleIntervalMs,
      pollIntervalMs: cadence.pollIntervalMs,
    });
    const startedAt = iso(startUs);
    const endedAt = iso(endUs);
    const flag = decideFlag(attribution, cpuRatio, startedAt, endedAt, {
      flagThresholdMs: data.flagThresholdMs,
      minCpuRatio: data.minCpuRatio,
      sampleIntervalMs: cadence.sampleIntervalMs,
    });
    const report: EventLoopBlockReport = {
      blockedMs: block.blockedMs,
      startedAtUs: startUs,
      endedAtUs: endUs,
      startedAt,
      endedAt,
      attribution,
      cpuRatio,
      flag,
      reportable: block.report,
      suppressedBlocks: block.suppressedBlocks,
      ...(current?.terminated ? { terminated: current.terminated } : {}),
      ...(current?.terminationRefused ? { terminationRefused: current.terminationRefused } : {}),
    };
    post({ type: 'block', report });

    try {
      current?.session?.disconnect();
    } catch {
      // already disconnected
    }
  };

  let announcedReady = false;
  const poll = () => {
    if (!announcedReady) {
      announcedReady = true;
      post({ type: 'ready' });
    }
    const nowUs = now();
    const nowMs = nowUs / 1000;
    const block = detector.poll(nowMs, Number(Atomics.load(shared, 0)) / 1000);
    if (block) onBlockEnded(block, nowUs);

    checkTerminationAftermath(nowUs);

    const { blockedSince } = detector;
    if (blockedSince === undefined) return;

    if (!state) {
      state = {
        startUs: blockedSince * 1000,
        detectedAtUs: nowUs,
        cpuAtDetect: cpuUsage(),
        samples: [],
        sessionFailed: false,
        inFlight: false,
        lastLandedUs: 0,
        lastLiveReportUs: nowUs,
      };
    }
    const current = state;

    if (
      !current.session &&
      !current.sessionFailed &&
      nowMs - blockedSince >= cadence.sampleAfterMs
    ) {
      openSession(current);
      if (current.session) postSample(current);
    } else if (
      current.session &&
      !current.sessionFailed &&
      !current.inFlight &&
      current.samples.length < MAX_SAMPLES_PER_BLOCK &&
      nowUs - current.lastLandedUs >= cadence.sampleIntervalMs * 1000
    ) {
      postSample(current);
    }

    maybeTerminate(current, nowUs);

    if (nowUs - current.lastLiveReportUs >= data.liveReportIntervalMs * 1000) {
      current.lastLiveReportUs = nowUs;
      writeLine(formatStillBlockedNotice(nowMs - blockedSince, latestTask(current)));
    }
  };

  // Referenced on purpose: nothing is ever posted to this worker, so this timer is what keeps it
  // alive. The main thread unrefs the Worker handle itself.
  const timer = setInterval(poll, cadence.pollIntervalMs);
  port.on('close', () => {
    clearInterval(timer);
    try {
      state?.session?.disconnect();
    } catch {
      // already disconnected
    }
  });
};

if (!isMainThread && parentPort) {
  runWatchdogWorker(parentPort, workerData as WatchdogWorkerData);
}
