/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { encodeMetricScopes } from '@kbn/metrics';
import { TaskProcessMetrics } from './run_metrics';

it('finishes queued progress before sealing the final native collection', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const collector = jest.fn(async () => {
    if (collector.mock.calls.length === 1) {
      entered.resolve();
      await gate.promise;
    }
    return [];
  });
  const metrics = new TaskProcessMetrics(collector);
  const progress = metrics.collect();
  await entered.promise;
  const final = metrics.collect(true);
  const lateProgress = metrics.collect();
  expect(lateProgress).toBe(final);
  expect(collector).toHaveBeenCalledTimes(1);
  gate.resolve();
  expect(await progress).toEqual({ sequence: 1, encoded: encodeMetricScopes([]) });
  expect(await final).toEqual({ sequence: 2, encoded: encodeMetricScopes([]) });
  expect(await metrics.collect()).toEqual({ sequence: 2, encoded: encodeMetricScopes([]) });
  expect(collector).toHaveBeenCalledTimes(2);
  expect(() => metrics.addDelta([])).toThrow('after execution finalization');
});

it('recovers the collection queue after a rejected native collection', async () => {
  const collector = jest.fn(async () => []);
  collector.mockRejectedValueOnce(new Error('observable failed'));
  const metrics = new TaskProcessMetrics(collector);
  await expect(metrics.collect()).rejects.toThrow('observable failed');
  expect(await metrics.collect(true)).toEqual({ sequence: 1, encoded: encodeMetricScopes([]) });
  expect(collector).toHaveBeenCalledTimes(2);
});

it('keeps forwarded deltas in the same execution snapshot without a local provider', async () => {
  const metrics = new TaskProcessMetrics();
  expect(await metrics.collect()).toBeUndefined();
  metrics.addDelta([]);
  metrics.addDelta([]);
  expect(await metrics.collect(true)).toEqual({ sequence: 2, encoded: encodeMetricScopes([]) });
});
