/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import 'reflect-metadata';
import { Container, inject, injectable } from 'inversify';
import { createToken } from '@kbn/core-di';
import { Request } from '@kbn/core-di-server';
import { createRunnerInScope } from './resolve_needs';
import { registerTaskType } from './register_task_type';
import { defineTaskType } from './task_type';
import type { RunContext } from '../task';

const GreetingToken = createToken<string>('test.Greeting');

@injectable()
class Runner {
  constructor(@inject(GreetingToken) public readonly greeting: string) {}
}

const context = (overrides: Partial<RunContext> = {}) =>
  ({
    taskInstance: { id: 'task-1' },
    signal: new AbortController().signal,
    executionUuid: 'uuid',
    setCustomTaskRunEventFields: jest.fn(),
    ...overrides,
  } as unknown as RunContext);

const unit = defineTaskType({
  type: 'test:greet',
  definition: { title: 'Greet' },
  requiresFakeRequest: false,
  needs: { greeting: GreetingToken, runner: Runner },
  createRunner: ({ greeting, runner }) => ({
    run: async () => ({ state: { greeting, same: runner.greeting === greeting } }),
  }),
});

describe('task type modules', () => {
  describe('createRunnerInScope', () => {
    it('resolves tokens and classes the unit needs and runs the runner', async () => {
      const container = new Container({ defaultScope: 'Singleton' });
      container.bind(GreetingToken).toConstantValue('hello');
      const task = await createRunnerInScope(unit, container, context());
      await expect(task.run()).resolves.toEqual({ state: { greeting: 'hello', same: true } });
    });

    it('binds the fake request in the run scope only', async () => {
      const container = new Container({ defaultScope: 'Singleton' });
      const fakeRequest = { headers: {} };
      const requestUnit = defineTaskType({
        type: 'test:request',
        definition: { title: 'Request' },
        needs: { request: Request },
        createRunner: ({ request }) => ({ run: async () => ({ state: { seen: request } }) }),
      });

      const task = await createRunnerInScope(
        requestUnit,
        container,
        context({ fakeRequest: fakeRequest as never })
      );
      await expect(task.run()).resolves.toEqual({ state: { seen: fakeRequest } });
      expect(container.isBound(Request)).toBe(false);
    });

    it('refuses a run without a fake request when the unit requires one', async () => {
      const container = new Container();
      const requestUnit = defineTaskType({
        type: 'test:needs_request',
        definition: { title: 'Needs request' },
        needs: {},
        createRunner: () => ({ run: async () => ({ state: {} }) }),
      });
      await expect(createRunnerInScope(requestUnit, container, context())).rejects.toThrow(
        /without Task Manager fakeRequest/
      );
    });
  });

  describe('registerTaskType', () => {
    const register = (provider: Parameters<typeof registerTaskType>[2]) => {
      const registerTaskDefinitions = jest.fn();
      registerTaskType({ registerTaskDefinitions }, unit as never, provider, { timeout: '1m' });
      return registerTaskDefinitions.mock.calls[0][0]['test:greet'];
    };

    it('registers the unit definition with overrides and a runner fed by the provider', async () => {
      const definition = register({
        resolve: async () => ({ greeting: 'hi', runner: new Runner('hi') }),
      });
      expect(definition).toEqual(
        expect.objectContaining({
          title: 'Greet',
          timeout: '1m',
          createTaskRunner: expect.any(Function),
        })
      );
      const task = definition.createTaskRunner(context());
      await expect(task.run()).resolves.toEqual({ state: { greeting: 'hi', same: true } });
    });

    it('resolves services from a container provider', async () => {
      const container = new Container({ defaultScope: 'Singleton' });
      container.bind(GreetingToken).toConstantValue('from container');
      const definition = register({ container: () => container });
      const task = definition.createTaskRunner(context());
      await expect(task.run()).resolves.toEqual({
        state: { greeting: 'from container', same: true },
      });
    });

    it('cancels a runner created after the run was cancelled', async () => {
      const cancel = jest.fn();
      const slowUnit = defineTaskType({
        type: 'test:greet',
        definition: { title: 'Greet' },
        requiresFakeRequest: false,
        needs: {},
        createRunner: () => ({ run: async () => ({ state: {} }), cancel }),
      });
      const registerTaskDefinitions = jest.fn();
      registerTaskType({ registerTaskDefinitions }, slowUnit, { resolve: () => ({}) });
      const task = registerTaskDefinitions.mock.calls[0][0]['test:greet'].createTaskRunner(
        context()
      );
      await task.cancel();
      await task.run();
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });
});
