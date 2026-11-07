/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import { AdHocTaskCounter } from '../lib/adhoc_task_counter';
import {
  createHostFeatureFlags,
  getActiveTaskExecutions,
  incrementCreatedTaskCount,
  runFlushers,
  runInRunContext,
} from './run_context';

describe('task process run context', () => {
  it('returns the value of the run, or the error it threw', async () => {
    const failure = new Error('boom');

    expect(await runInRunContext(async () => 'done')).toEqual({ value: 'done' });
    expect(
      (
        await runInRunContext(async () => {
          throw failure;
        })
      ).error
    ).toBe(failure);
  });

  it('isolates task counts and tracks concurrent executions through success and failure', async () => {
    const firstCounter = new AdHocTaskCounter();
    const secondCounter = new AdHocTaskCounter();
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runInRunContext(
      async () => {
        incrementCreatedTaskCount(2);
        await gate;
        incrementCreatedTaskCount();
      },
      { executionId: 'first::execution', adHocTaskCounter: firstCounter }
    );
    const failure = new Error('second failed');
    const second = await runInRunContext(
      async () => {
        expect(getActiveTaskExecutions().sort()).toEqual(['first::execution', 'second::execution']);
        incrementCreatedTaskCount(5);
        throw failure;
      },
      { executionId: 'second::execution', adHocTaskCounter: secondCounter }
    );
    expect(second.error).toBe(failure);
    expect(getActiveTaskExecutions()).toEqual(['first::execution']);
    releaseFirst();
    await first;
    expect(getActiveTaskExecutions()).toEqual([]);
    expect([firstCounter.count, secondCounter.count]).toEqual([3, 5]);
    expect(() => incrementCreatedTaskCount()).toThrow('require an active task execution');
  });

  describe('feature flags', () => {
    const flags = createHostFeatureFlags();

    it('answers with what Kibana evaluated for the run that asks', async () => {
      const { value } = await runInRunContext(
        async () => firstValueFrom(flags.getBooleanValue$('a.flag', false)),
        { featureFlags: { 'a.flag': true } }
      );

      expect(value).toBe(true);
    });

    it('answers with the fallback for a flag the run was not given, or of another type', async () => {
      const { value } = await runInRunContext(
        async () => [
          await firstValueFrom(flags.getBooleanValue$('missing', true)),
          await firstValueFrom(flags.getStringValue$('a.flag', 'fallback')),
        ],
        { featureFlags: { 'a.flag': true } }
      );

      expect(value).toEqual([true, 'fallback']);
    });

    it('keeps the flags of runs that overlap apart', async () => {
      const run = (flag: boolean, delay: number) =>
        runInRunContext(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            return firstValueFrom(flags.getBooleanValue$('a.flag', !flag));
          },
          { featureFlags: { 'a.flag': flag } }
        );

      const [first, second] = await Promise.all([run(true, 20), run(false, 1)]);

      expect([first.value, second.value]).toEqual([true, false]);
    });
  });

  describe('runFlushers', () => {
    const logger = { warn: jest.fn() };
    beforeEach(() => logger.warn.mockReset());

    it('waits for every flusher', async () => {
      const done: string[] = [];
      await runFlushers(
        [
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            done.push('slow');
          },
          async () => {
            done.push('fast');
          },
        ],
        logger
      );

      expect(done.sort()).toEqual(['fast', 'slow']);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs a flusher that fails and still waits for the others', async () => {
      const other = jest.fn().mockResolvedValue(undefined);

      await runFlushers([async () => Promise.reject(new Error('endpoint down')), other], logger);

      expect(other).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Flush failed: endpoint down');
    });

    it('identifies only the callbacks still pending at the deadline', async () => {
      const blocked = () => new Promise<void>(() => {});
      const completed = async () => {};

      await expect(runFlushers([blocked, completed], logger, 20)).resolves.toBe(false);

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pending: blocked;'));
    });

    it('gives up after the timeout, with a warning', async () => {
      const startedAt = Date.now();

      await runFlushers([() => new Promise<void>(() => {})], logger, 20);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not finish in 20ms'));
    });
  });
});
