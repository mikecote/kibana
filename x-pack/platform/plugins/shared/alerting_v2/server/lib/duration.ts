/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

const DURATION_RE = /^(\d+)(ms|s|m|h|d|w)$/;

const MS_PER_MINUTE = 60 * 1000;

/**
 * Validates a duration string such as "5m". Same rule and message as `validateDuration` in
 * `@kbn/alerting-v2-schemas`, kept here so task runtimes do not load that package (it pulls in the
 * ES|QL grammar and zod).
 */
export function validateDuration(value: string): string | void {
  if (!DURATION_RE.test(value)) {
    return 'Invalid duration. Expected format like "5m", "1h", "30s", "250ms"';
  }
}

/**
 * Converts a `schedule.every` duration into the number of rule runs it
 * represents per minute. Returns 0 for invalid or non-positive durations.
 */
export function convertEveryToSchedulesPerMinute(every: string): number {
  let durationMs: number;
  try {
    durationMs = parseDurationToMs(every);
  } catch {
    return 0;
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }

  return MS_PER_MINUTE / durationMs;
}

export function parseDurationToMs(value: string): number {
  const match = value.match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid duration "${value}"`);
  }

  const amount = Number(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    case 'w':
      return amount * 7 * 24 * 60 * 60 * 1000;
    default:
      // exhaustive
      throw new Error(`Unsupported duration unit "${unit}"`);
  }
}
