/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { TaskRegisterDefinition } from '@kbn/task-manager-plugin/server';
import type {
  TaskHost,
  TaskTypeModule,
  TaskTypeRegistrationOptions,
} from '@kbn/task-manager-plugin/server/task_type_module';

/**
 * Makes `registerTaskType` of a Task Manager setup mock record the task definition Task Manager
 * would register for each module, with the host Kibana builds for it (what the plugin hands over as
 * `host.plugins`).
 */
export const captureTaskDefinitions = (
  taskManagerSetup: {
    registerTaskType:
      | jest.Mock
      | ((module: TaskTypeModule, options?: TaskTypeRegistrationOptions) => void);
  },
  taskDefinitions: Record<string, TaskRegisterDefinition>
) => {
  (taskManagerSetup.registerTaskType as jest.Mock).mockImplementation(
    (module: TaskTypeModule, options?: TaskTypeRegistrationOptions) => {
      const { type, createTaskRunner, ...definition } = module;
      taskDefinitions[type] = {
        ...definition,
        createTaskRunner: (context) => {
          // The runner is made as soon as the host is, so a cancel that arrives first still reaches it.
          const runner = Promise.resolve(options?.hostExtensions?.plugins?.()).then((plugins) =>
            createTaskRunner(context, { plugins } as unknown as TaskHost)
          );
          return {
            run: async () => (await runner).run(),
            cancel: async () => (await runner).cancel?.(),
          };
        },
      } as TaskRegisterDefinition;
    }
  );
};
