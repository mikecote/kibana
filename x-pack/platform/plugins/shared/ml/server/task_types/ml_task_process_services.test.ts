/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Subject } from 'rxjs';
import type { ILicense } from '@kbn/licensing-types';
import { createMlTaskProcessServices } from './ml_task_process_services';
import {
  createMlRuleLicense,
  createMlRuleServicesDeps,
} from './ml_task_process_services.test_helpers';

describe('createMlTaskProcessServices', () => {
  it('does not read the host before the executor runs', () => {
    const deps = createMlRuleServicesDeps();
    Object.defineProperty(deps, 'runtime', {
      get: () => {
        throw new Error('The execution runtime is not available while registering');
      },
    });
    Object.defineProperty(deps.host, 'plugins', {
      get: () => {
        throw new Error('Execution plugins are not available while registering');
      },
    });
    expect(() => createMlTaskProcessServices(deps)).not.toThrow();
  });

  it('runs the executor once the license is known', async () => {
    const license$ = new Subject<ILicense>();
    const executor = jest.fn(async (_options: { marker: string }) => ({ state: {} }));
    const { withLicense } = createMlTaskProcessServices(createMlRuleServicesDeps(license$));
    const run = withLicense({ executor }).executor({ marker: 'native' });

    await Promise.resolve();
    expect(executor).not.toHaveBeenCalled();

    license$.next(createMlRuleLicense());
    await expect(run).resolves.toEqual({ state: {} });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith({ marker: 'native' });
  });
});
