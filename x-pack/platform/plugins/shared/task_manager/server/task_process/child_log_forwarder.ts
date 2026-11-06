/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createInterface } from 'readline';
import type { Readable } from 'stream';
import type { Logger } from '@kbn/core/server';

interface ChildRecord {
  message: string;
  log?: { level?: string; logger?: string };
  error?: { message?: string; type?: string; stack_trace?: string };
}

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
const LEVELS: Level[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

/** The lowest level `logger` writes, which is what the child logs at: it never builds a record Kibana would drop. */
export const getChildLogLevel = (logger: Pick<Logger, 'isLevelEnabled'>): Level =>
  LEVELS.find((level) => logger.isLevelEnabled(level)) ?? 'error';

/**
 * Reads the log lines a child writes (one JSON record each, in Kibana's layout) and logs them with
 * Kibana's own logger, so they carry Kibana's layout, appenders and level filters. The task type
 * and the run's execution id label every line, which a child cannot do for the loggers of plugins.
 * A line that is not a record (a crash, a stray `console.log`) is logged as is.
 */
export const forwardChildLogs = ({
  stream,
  logger,
  labels,
  fallbackLevel = 'info',
}: {
  stream: Readable;
  logger: Logger;
  labels: Record<string, string>;
  fallbackLevel?: Level;
}) => {
  const rl = createInterface({ input: stream });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let record: ChildRecord | undefined;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
        record = parsed;
      }
    } catch {
      // not a record
    }
    if (!record) {
      logger[fallbackLevel](line, { labels });
      return;
    }
    const level = String(record.log?.level ?? 'info').toLowerCase();
    const method = (LEVELS as string[]).includes(level) ? (level as Level) : 'info';
    const stack = record.error?.stack_trace;
    logger[method](stack ? `${record.message}\n${stack}` : record.message, {
      labels: { ...labels, child_logger: record.log?.logger ?? '' },
      ...(record.error
        ? { error: { message: record.error.message, type: record.error.type } }
        : {}),
    });
  });
  return () => rl.close();
};
