/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createInitialMiddleware } from './lib/middleware';
import { createTaskSchedulingMiddleware } from './task_scheduling_middleware';
import type { TaskSchedulingContribution } from './task_scheduling_contribution';

const contribution = (id: string, visit: (id: string) => void): TaskSchedulingContribution => ({
  middleware: [
    {
      id,
      create: () => ({
        ...createInitialMiddleware(),
        beforeSave: async (context) => {
          visit(id);
          return context;
        },
      }),
    },
  ],
});

describe('native task scheduling middleware', () => {
  it('uses the native chain order and creates only the providers Main registered', async () => {
    const visits: string[] = [];
    const unused = jest.fn();
    const chain = createTaskSchedulingMiddleware(
      ['first', 'second'],
      [
        contribution('second', (id) => visits.push(id)),
        { middleware: [{ id: 'unused', create: unused }] },
        contribution('first', (id) => visits.push(id)),
      ],
      {}
    );
    const context = { taskInstance: { taskType: 'native', params: {}, state: {} } };
    expect(await chain.beforeSave(context)).toBe(context);
    expect(visits).toEqual(['second', 'first']);
    expect(unused).not.toHaveBeenCalled();
  });

  it('checks all registrations before constructing any middleware', () => {
    const create = jest.fn();
    expect(() =>
      createTaskSchedulingMiddleware(
        ['present', 'missing'],
        [{ middleware: [{ id: 'present', create }] }],
        {}
      )
    ).toThrow('not available for missing');
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects duplicate providers and duplicate dispatch ids', () => {
    expect(() =>
      createTaskSchedulingMiddleware(
        [],
        [contribution('same', jest.fn()), contribution('same', jest.fn())],
        {}
      )
    ).toThrow('Duplicate native scheduling middleware provider');
    expect(() =>
      createTaskSchedulingMiddleware(['same', 'same'], [contribution('same', jest.fn())], {})
    ).toThrow('Duplicate registered scheduling middleware');
  });
});
