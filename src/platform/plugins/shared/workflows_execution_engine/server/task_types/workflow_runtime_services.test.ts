/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type {
  WorkflowStepsContribution,
  WorkflowStepsContributionContext,
} from '@kbn/workflows-extensions/server';
import { WorkflowRuntimeServices } from './workflow_runtime_services';

const context: WorkflowStepsContributionContext = {
  host: {},
  logger: loggingSystemMock.createLogger(),
  settings: {},
  isServerless: false,
  kibanaVersion: '9.0.0',
};
const contribution = (
  provides: NonNullable<WorkflowStepsContribution['provides']>
): WorkflowStepsContribution => ({
  provides,
  register: () => {},
});

describe('workflow runtime services', () => {
  it('waits for asynchronous effects and any completion work they register', async () => {
    const services = new WorkflowRuntimeServices([], () => context);
    const pending = Promise.withResolvers<void>();
    const done = jest.fn();
    services.registerRunCompletion(async () => {
      await pending.promise;
      services.registerRunCompletion(async () => {
        done();
      });
    });
    const completed = services.complete();
    expect(done).not.toHaveBeenCalled();
    pending.resolve();
    await completed;
    expect(done).toHaveBeenCalledTimes(1);
    await services.complete();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('waits for other effects before reporting a completion failure', async () => {
    const services = new WorkflowRuntimeServices([], () => context);
    const pending = Promise.withResolvers<void>();
    const done = jest.fn();
    services.registerRunCompletion(async () => {
      throw new Error('failed effect');
    });
    services.registerRunCompletion(async () => {
      await pending.promise;
      done();
    });
    const completed = services.complete();
    const asserted = expect(completed).rejects.toThrow('Workflow service completion failed');
    expect(done).not.toHaveBeenCalled();
    pending.resolve();
    await asserted;
    expect(done).toHaveBeenCalledTimes(1);
  });
  it('creates a service lazily once per execution and passes the current context', () => {
    const provide = jest.fn(() => ({ value: 1 }));
    const first = new WorkflowRuntimeServices([contribution({ test: provide })], () => context);
    const second = new WorkflowRuntimeServices([contribution({ test: provide })], () => context);
    expect(provide).not.toHaveBeenCalled();
    expect(first.getService('test')).toBe(first.getService('test'));
    expect(first.getService('test')).not.toBe(second.getService('test'));
    expect(provide).toHaveBeenCalledTimes(2);
    expect(provide).toHaveBeenCalledWith(context);
  });

  it('rejects duplicate providers and collisions with engine services', () => {
    const provider = contribution({ test: () => ({}) });
    expect(() => new WorkflowRuntimeServices([provider, provider], () => context)).toThrow(
      'Duplicate'
    );
    expect(() => new WorkflowRuntimeServices([provider], () => context, { test: {} })).toThrow(
      'Duplicate'
    );
  });

  it('rejects a missing service and duplicate registrations', () => {
    const services = new WorkflowRuntimeServices([], () => context);
    expect(() => services.getService('missing')).toThrow('No workflow runtime service provider');
    const instance = {};
    services.registerService('test', instance);
    expect(services.getService('test')).toBe(instance);
    expect(() => services.registerService('test', {})).toThrow('Duplicate');
  });

  it('reports circular providers and releases the construction guard after failure', () => {
    const services = new WorkflowRuntimeServices(
      [
        contribution({
          first: () => services.getService('second'),
          second: () => services.getService('first'),
        }),
      ],
      () => context
    );
    expect(() => services.getService('first')).toThrow(
      'Circular workflow runtime service dependency: first'
    );
    expect(() => services.getService('second')).toThrow(
      'Circular workflow runtime service dependency: second'
    );
  });
});
