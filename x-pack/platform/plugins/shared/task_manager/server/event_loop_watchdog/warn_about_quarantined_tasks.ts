/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { TaskStatus } from '../task';
import type { FetchResult, SearchOpts } from '../task_store';

/** PoC only: how many quarantined task ids to list in the one startup warning. */
const MAX_LOGGED_TASKS = 100;

export interface QuarantinedTaskStore {
  fetch(opts: SearchOpts, limitResponse?: boolean): Promise<FetchResult>;
}

/**
 * PoC only: logs a bounded list of tasks left quarantined by the event loop watchdog, so an
 * operator restarting Kibana after a block can see what needs releasing (e.g. via `runSoon`).
 * Rejects if the lookup fails; callers that don't want a failed lookup to fail startup should
 * catch it (not awaited elsewhere).
 */
export async function warnAboutQuarantinedTasks(
  taskStore: QuarantinedTaskStore,
  logger: Logger
): Promise<void> {
  const { docs } = await taskStore.fetch(
    {
      query: { term: { 'task.status': TaskStatus.Quarantined } },
      size: MAX_LOGGED_TASKS,
    },
    true
  );
  if (docs.length === 0) return;

  logger.warn(
    `Found ${docs.length} task(s) quarantined by the event loop watchdog, not claimed until ` +
      `released (e.g. via runSoon): ${docs.map((doc) => `${doc.taskType}:${doc.id}`).join(', ')}`,
    { tags: ['event-loop-watchdog', 'event-loop-quarantined'] }
  );
}
