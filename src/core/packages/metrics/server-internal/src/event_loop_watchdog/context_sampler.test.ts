/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaExecutionContext } from '@kbn/core-execution-context-common';
import { contextKey, formatAttribution, partitionBlock } from './context_sampler';
import type { BlockAttribution, ContextSample } from './types';

const ms = (value: number) => value * 1000;
const taskContext = (id: string): KibanaExecutionContext => ({
  type: 'task manager',
  name: 'run my-task',
  id,
});
const sample = (
  postedMs: number,
  landedMs: number | undefined,
  context: KibanaExecutionContext | null
): ContextSample => ({
  postedAtUs: ms(postedMs),
  landedAtUs: landedMs === undefined ? undefined : ms(landedMs),
  context,
  missing: false,
});
const total = (a: BlockAttribution) =>
  a.unsampledMs +
  a.opaqueMs +
  a.noContextMs +
  a.perContext.reduce((sum, c) => sum + c.observedMs, 0);

describe('contextKey', () => {
  it('is the same for two contexts with the same type/name/id', () => {
    expect(contextKey(taskContext('a'))).toBe(contextKey(taskContext('a')));
  });

  it('differs by id', () => {
    expect(contextKey(taskContext('a'))).not.toBe(contextKey(taskContext('b')));
  });

  it('includes the child chain', () => {
    const outer: KibanaExecutionContext = {
      ...taskContext('a'),
      child: { type: 'alerting_v2', name: 'dispatcher step', id: 'step-1' },
    };
    expect(contextKey(outer)).not.toBe(contextKey(taskContext('a')));
    expect(contextKey(outer)).toBe(contextKey(outer));
  });
});

describe('partitionBlock', () => {
  it('is entirely unsampled without samples', () => {
    const a = partitionBlock(0, ms(2000), []);
    expect(a).toMatchObject({ blockedMs: 2000, unsampledMs: 2000, opaqueMs: 0, samples: 0 });
    expect(a.perContext).toEqual([]);
  });

  it('credits a context that was current at every sample, and the partition adds up', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 501, taskContext('a')),
      sample(751, 752, taskContext('a')),
      sample(1002, 1003, taskContext('a')),
      sample(1253, 1254, taskContext('a')),
    ]);
    expect(a.perContext).toHaveLength(1);
    expect(a.perContext[0]).toMatchObject({ key: contextKey(taskContext('a')), samples: 4 });
    expect(a.unsampledMs).toBeGreaterThanOrEqual(500);
    expect(a.opaqueMs).toBeCloseTo(4);
    expect(total(a)).toBeCloseTo(2000);
  });

  it('never credits time before a late landing to the context it names', () => {
    // Posted at 500 during one long native call that returns at 1900, where context b runs next.
    const a = partitionBlock(0, ms(2000), [sample(500, 1900, taskContext('b'))]);
    expect(a.opaqueMs).toBeCloseTo(1400);
    expect(a.perContext[0].key).toBe(contextKey(taskContext('b')));
    expect(a.perContext[0].observedMs).toBeCloseTo(100);
    expect(total(a)).toBeCloseTo(2000);
  });

  it('credits each interval to the context landed in, when the current context changes', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 501, taskContext('a')),
      sample(751, 752, taskContext('a')),
      sample(1002, 1003, taskContext('b')),
      sample(1253, 1254, taskContext('b')),
    ]);
    const byKey = Object.fromEntries(a.perContext.map((c) => [c.key, c.observedMs]));
    // a: two intervals of ~250ms; b: one interval plus the capped tail after the last landing.
    expect(byKey[contextKey(taskContext('a'))]).toBeCloseTo(500, -1);
    expect(byKey[contextKey(taskContext('b'))]).toBeCloseTo(250 + 275, -1);
    expect(total(a)).toBeCloseTo(2000);
  });

  it('counts a sample still in flight at the end of the block as opaque', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 501, taskContext('a')),
      sample(751, undefined, null),
    ]);
    expect(a.opaqueMs).toBeCloseTo(1 + 1249);
    expect(a.perContext[0].observedMs).toBeCloseTo(250);
    expect(total(a)).toBeCloseTo(2000);
  });

  it('reports opaque time bounded by the same context as inferred, without crediting it', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 600, taskContext('a')),
      sample(700, 1500, taskContext('a')),
    ]);
    expect(a.inferredMs).toBeCloseTo(800);
    expect(a.opaqueMs).toBeCloseTo(900);
    expect(a.perContext[0].observedMs).toBeLessThan(500);
  });

  it('credits at most one interval after the last landing, the rest is unsampled', () => {
    const a = partitionBlock(0, ms(10_000), [sample(500, 501, taskContext('a'))]);
    expect(a.perContext[0].observedMs).toBeCloseTo(275);
    expect(a.unsampledMs).toBeCloseTo(500 + 10_000 - 501 - 275);
    expect(a.unsampledPrefixMs).toBeCloseTo(500);
    expect(a.unsampledTailMs).toBeCloseTo(10_000 - 501 - 275);
    expect(total(a)).toBeCloseTo(10_000);
  });

  it('accounts for time without an execution context', () => {
    const a = partitionBlock(0, ms(2000), [sample(500, 501, null), sample(751, 752, null)]);
    expect(a.perContext).toEqual([]);
    expect(a.noContextMs).toBeGreaterThan(0);
  });

  it('reports a missing accessor', () => {
    const missing: ContextSample = {
      postedAtUs: ms(500),
      landedAtUs: ms(501),
      context: null,
      missing: true,
    };
    expect(partitionBlock(0, ms(1000), [missing]).missingAccessor).toBe(true);
  });

  it('sorts contexts by observed time', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 501, taskContext('a')),
      sample(751, 752, taskContext('b')),
      sample(1002, 1003, taskContext('b')),
    ]);
    expect(a.perContext.map((c) => c.key)).toEqual([
      contextKey(taskContext('b')),
      contextKey(taskContext('a')),
    ]);
  });

  it('keys nested (child) contexts separately from their parent', () => {
    const outer = taskContext('a');
    const nested: KibanaExecutionContext = {
      ...outer,
      child: { type: 'alerting_v2', name: 'dispatcher step', id: 'step-1' },
    };
    const a = partitionBlock(0, ms(2000), [
      sample(500, 501, outer),
      sample(751, 752, nested),
      sample(1002, 1003, nested),
    ]);
    expect(a.perContext).toHaveLength(2);
    expect(a.perContext.find((c) => c.key === contextKey(nested))?.context).toEqual(nested);
  });
});

describe('formatAttribution', () => {
  it('reports no samples at all', () => {
    const a = partitionBlock(0, ms(2000), []);
    expect(formatAttribution(a)).toBe('no execution context was sampled');
  });

  it('reports no context current when every sample lands outside any context', () => {
    const a = partitionBlock(0, ms(2000), [sample(500, 501, null), sample(751, 752, null)]);
    expect(formatAttribution(a)).toBe('no execution context was current while sampled');
  });

  it('names the top context and its share, with no parenthetical when nothing else is notable', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 500, taskContext('a')),
      sample(751, 751, taskContext('a')),
    ]);
    expect(formatAttribution(a)).toMatch(
      /^task manager "run my-task" id=a held ~\d+ms of ~\d+ms sampled$/
    );
  });

  it('mentions opaque and no-context time alongside the top context', () => {
    const a = partitionBlock(0, ms(2000), [
      sample(500, 1900, taskContext('a')), // mostly opaque (a long native call before landing)
      sample(1950, 1951, null),
    ]);
    expect(formatAttribution(a)).toMatch(
      /^task manager "run my-task" id=a held ~\d+ms of ~\d+ms sampled \(\d+ms opaque, \d+ms outside any context\)$/
    );
  });
});
