/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { CoordinatorCapabilities } from './coordinator_capabilities';
import type { CoordinatorCallbacks } from './coordinator_capabilities';

describe('CoordinatorCapabilities', () => {
  it('gates run capabilities by the current lease and reads the live dispatching pool', async () => {
    let callbacks: CoordinatorCallbacks | undefined;
    let pool = ['first'];
    const report = jest.fn();
    const root = new CoordinatorCapabilities(() => callbacks);
    expect(() => root.forRun('before-ready')).toThrow('No leased task execution');
    callbacks = { getCurrentTasksInPool: () => pool, reportProgress: report };
    const run = root.forRun('active');
    await expect(run.getCurrentTasksInPool()).resolves.toEqual(['first']);
    pool = ['second'];
    await expect(run.getCurrentTasksInPool()).resolves.toEqual(['second']);
    run.reportProgress(2);
    expect(report).toHaveBeenCalledWith(2);
    callbacks = undefined;
    await expect(run.getCurrentTasksInPool()).rejects.toThrow('No leased task execution');
    expect(() => run.reportProgress(3)).toThrow('No leased task execution');
    expect(report).toHaveBeenCalledTimes(1);
  });
});
