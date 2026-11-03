/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Container } from 'inversify';
import { Request } from '@kbn/core-di-server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { CancellableTask, RunContext } from '../task';
import type { NeedsSpec, ResolvedNeeds, TaskTypeModule } from './task_type';

/**
 * Creates the run's task the way both hosts do: fork the container so request-scoped services
 * resolve against the run's fake request, resolve what the task type needs, build the runner, and
 * release the fork when the run settles.
 */
export const createRunnerInScope = async <N extends NeedsSpec>(
  unit: TaskTypeModule<N>,
  parent: Container,
  context: RunContext
): Promise<CancellableTask> => {
  if ((unit.requiresFakeRequest ?? true) && !context.fakeRequest) {
    throw new Error(
      `Cannot execute ${unit.type} task without Task Manager fakeRequest. Ensure the task is scheduled with an API key (task id: ${context.taskInstance.id})`
    );
  }
  const scope = new Container({ parent, autoBind: true, defaultScope: 'Singleton' });
  if (context.fakeRequest) {
    scope.bind(Request).toConstantValue(context.fakeRequest as KibanaRequest);
  }

  // Classes are built by the container: bind them in the run's scope, as alerting v2 does today.
  Object.values(unit.needs).forEach((need) => {
    if (typeof need === 'function') scope.bind(need).toSelf().inRequestScope();
  });

  const entries = await Promise.all(
    Object.entries(unit.needs).map(
      async ([name, token]) => [name, await scope.getAsync(token as never)] as const
    )
  );
  const task = unit.createRunner(Object.fromEntries(entries) as ResolvedNeeds<N>, context);
  const release = () => scope.unbindAll();
  return {
    ...task,
    run: async () => {
      try {
        return await task.run();
      } finally {
        await release();
      }
    },
  };
};
