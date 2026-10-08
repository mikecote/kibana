/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export { EventLoopWatchdog } from './watchdog';
export type { EventLoopWatchdogDeps } from './watchdog';
export type { TaskRunScope } from './types';

import type { EventLoopWatchdog } from './watchdog';
import type { TaskRunScope } from './types';

let activeWatchdog: EventLoopWatchdog | undefined;

/** Registers (or clears) the process-wide watchdog used by task-runner notifications. */
export const setActiveEventLoopWatchdog = (watchdog: EventLoopWatchdog | undefined): void => {
  activeWatchdog = watchdog;
};

/** A scope that does nothing, used when no watchdog is active. */
const noopRunScope: TaskRunScope = {
  handle: 0,
  run: (fn) => fn(),
  end: () => {},
};

/**
 * Announces a task run to the watchdog and returns a scope whose `run` must wrap the
 * task's execution, so the watchdog can (when current-task tracking is enabled) attribute
 * an event-loop block to this exact run. Safe to call unconditionally.
 */
export const beginTaskRun = (taskId: string, taskType: string): TaskRunScope =>
  activeWatchdog?.beginRun(taskId, taskType) ?? noopRunScope;
