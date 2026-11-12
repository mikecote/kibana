/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createToken, defineCapability } from '@kbn/core-remote-common';
import { composeCapabilities } from './compose_capabilities';

const clockToken = createToken<{ now(): number }>('test.Clock');
const runToken = createToken<{ started: number }>('test.Run');
const clock = defineCapability({
  token: clockToken,
  placement: 'executor',
  scope: 'worker',
  needs: [] as const,
  create: () => ({ now: () => 42 }),
});
const run = defineCapability({
  token: runToken,
  placement: 'executor',
  scope: 'run',
  needs: [clockToken] as const,
  create: ([dependency]) => ({ started: dependency.now() }),
});

describe('composeCapabilities', () => {
  it('sorts dependencies, shares worker instances and isolates run instances', () => {
    const composition = composeCapabilities([run, clock], 'executor');
    const first = composition.createRun();
    const second = composition.createRun();
    expect(first.get(clockToken)).toBe(second.get(clockToken));
    expect(first.get(runToken)).not.toBe(second.get(runToken));
    expect(first.get(runToken).started).toBe(42);
    expect(() => composition.worker.get(runToken)).toThrow('Unavailable capability');
  });

  it('rejects cycles before creating any capabilities', () => {
    const create = jest.fn(() => ({ now: () => 0 }));
    expect(() =>
      composeCapabilities(
        [
          { ...clock, needs: [runToken], create },
          { ...run, scope: 'worker' },
        ],
        'executor'
      )
    ).toThrow('Capability cycle');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects missing dependencies and duplicate tokens', () => {
    expect(() => composeCapabilities([run], 'executor')).toThrow('Missing capability: test.Clock');
    expect(() => composeCapabilities([clock, clock], 'executor')).toThrow('Duplicate capability');
  });

  it('rejects worker factories that capture a run-scoped dependency', () => {
    expect(() =>
      composeCapabilities(
        [
          { ...run, scope: 'worker' },
          {
            ...clock,
            scope: 'run',
          },
        ],
        'executor'
      )
    ).toThrow('Worker capability cannot depend on run scope');
  });

  it('binds the other placement explicitly without constructing its implementations', () => {
    const create = jest.fn(() => ({ now: () => 0 }));
    const manifest = [{ ...clock, placement: 'coordinator' as const, create }, run];
    expect(() => composeCapabilities(manifest, 'executor')).toThrow(
      'Missing capability: test.Clock'
    );
    const imported = { now: () => 99 };
    const composition = composeCapabilities(
      manifest,
      'executor',
      new Map([[clockToken, imported]])
    );
    expect(composition.createRun().get(runToken)).toEqual({ started: 99 });
    expect(create).not.toHaveBeenCalled();
  });
});
