/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { TaskProviderRegistry } from '../../../task_providers/types';

export const contribution: WorkflowStepsContribution = {
  register: (_registry, { host, services }) => {
    if (!services) throw new Error('Task provider fixture requires execution services');
    const providers = services.getService<TaskProviderRegistry>('evals.taskProviders');
    providers.register({
      name: 'suite.custom_task',
      run: async (context) => {
        const output = { ...context.input, source: 'custom-task-provider' };
        await (host as TaskHost).elasticsearch.asInternalUser.index(
          {
            index: 'test-evals-provider-output',
            id: 'custom-task',
            refresh: 'wait_for',
            document: { output, connectorId: context.connectorId },
          },
          { signal: context.abortSignal }
        );
        return { output, traceId: '0af7651916cd43dd8448eb211c80319c' };
      },
    });
  },
};
