/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Subject } from 'rxjs';
import { createMlTaskProcessServices } from './ml_task_process_services';

describe('createMlTaskProcessServices', () => {
  const createDeps = (license$: Subject<unknown>) =>
    ({
      host: { licensing: { license$ } },
      isServerless: false,
      settings: {},
    } as never);

  it('does not read the host before the executor runs', () => {
    expect(() => createMlTaskProcessServices({ settings: {} } as never)).not.toThrow();
  });

  it('runs the executor once the license is known', async () => {
    const license$ = new Subject<unknown>();
    const executor = jest.fn().mockResolvedValue({ state: {} });
    const { withLicense } = createMlTaskProcessServices(createDeps(license$));
    const run = withLicense({ executor }).executor({} as never);

    await Promise.resolve();
    expect(executor).not.toHaveBeenCalled();

    license$.next({
      status: 'active',
      getFeature: () => ({ isEnabled: true, isAvailable: true }),
      hasAtLeast: () => true,
      check: () => ({ state: 'valid' }),
      type: 'platinum',
    });
    await expect(run).resolves.toEqual({ state: {} });
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
