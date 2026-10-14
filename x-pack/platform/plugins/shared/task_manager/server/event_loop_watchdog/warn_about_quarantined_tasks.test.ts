/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import { TaskStatus } from '../task';
import {
  warnAboutQuarantinedTasks,
  type QuarantinedTaskStore,
} from './warn_about_quarantined_tasks';

describe('warnAboutQuarantinedTasks', () => {
  const logger = loggingSystemMock.createLogger();

  beforeEach(() => jest.clearAllMocks());

  it('does nothing when there are no quarantined tasks', async () => {
    const taskStore: QuarantinedTaskStore = {
      fetch: jest.fn().mockResolvedValue({ docs: [], versionMap: new Map() }),
    };

    await warnAboutQuarantinedTasks(taskStore, logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('queries for quarantined tasks, limiting the response', async () => {
    const taskStore: QuarantinedTaskStore = {
      fetch: jest.fn().mockResolvedValue({ docs: [], versionMap: new Map() }),
    };

    await warnAboutQuarantinedTasks(taskStore, logger);

    expect(taskStore.fetch).toHaveBeenCalledWith(
      { query: { term: { 'task.status': TaskStatus.Quarantined } }, size: 100 },
      true
    );
  });

  it('logs a bounded list of the quarantined tasks found', async () => {
    const taskStore: QuarantinedTaskStore = {
      fetch: jest.fn().mockResolvedValue({
        docs: [
          { id: 'foo', taskType: 'bar' },
          { id: 'baz', taskType: 'qux' },
        ],
        versionMap: new Map(),
      }),
    };

    await warnAboutQuarantinedTasks(taskStore, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      'Found 2 task(s) quarantined by the event loop watchdog, not claimed until released ' +
        '(e.g. via runSoon): bar:foo, qux:baz',
      { tags: ['event-loop-watchdog', 'event-loop-quarantined'] }
    );
  });

  it('propagates a failed lookup to the caller (the caller does not await it)', async () => {
    const taskStore: QuarantinedTaskStore = {
      fetch: jest.fn().mockRejectedValue(new Error('nope')),
    };

    await expect(warnAboutQuarantinedTasks(taskStore, logger)).rejects.toThrow('nope');
  });
});
