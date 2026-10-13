/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Whether the main thread, blocked in this stack, can be terminated without damaging Node.
 *
 * `Runtime.terminateExecution` unwinds the stack without running `finally` blocks. That is safe
 * for task code and for the wrappers around it, but not when the stack is rooted in a timer or
 * immediate callback: Node's timer loop pushes async hook state in JavaScript that the unwind
 * skips, which aborts the process ("async hook stack has become corrupted") or silently stops
 * timers from firing. Stacks that end in `processTicksAndRejections` (a microtask or an I/O
 * continuation) and in the async context wrappers every task run goes through are safe.
 *
 * A denylist on purpose: it names the only Node internals known to be unsafe. A microtask drained
 * between timers shows `runNextTicks` under `listOnTimeout`, so both are refused.
 */
const UNSAFE_FRAME = /\(node:internal\/timers:| at runNextTicks \(/;

export type StackGateResult = { safe: true } | { safe: false; frame: string };

export const isTerminationSafeStack = (
  stack: string | undefined,
  truncated = false
): StackGateResult => {
  if (!stack || !stack.includes('\n')) return { safe: false, frame: '<no stack>' };
  // The root frames are the ones that matter, and a truncated stack does not have them.
  if (truncated) return { safe: false, frame: '<stack deeper than the capture limit>' };
  for (const line of stack.split('\n')) {
    if (UNSAFE_FRAME.test(line)) return { safe: false, frame: line.trim() };
  }
  return { safe: true };
};
