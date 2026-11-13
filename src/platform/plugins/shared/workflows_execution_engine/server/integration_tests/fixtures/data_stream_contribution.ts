/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License, v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { mappings } from '@kbn/es-mappings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const TASK_DATA_STREAM_NAME = '.task-process-lazy-data';
const dataStreamMappings = {
  properties: {
    '@timestamp': mappings.date(),
    marker: mappings.keyword(),
  },
};
const definition = {
  name: TASK_DATA_STREAM_NAME,
  version: 1,
  template: { mappings: dataStreamMappings },
};

export const contribution: WorkflowStepsContribution = {
  declares: { dataStreams: [definition] },
  register: (registry, { host }) => {
    const { dataStreams } = host as TaskHost;
    if (!dataStreams) throw new Error('The data stream fixture requires Core data streams');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.data_stream.execute',
        label: 'Use a lazy Core data stream',
        description: 'Exercise native lazy initialization, reads and writes inside a worker',
        category: StepCategory.Kibana,
        inputSchema: z.object({
          write: z.boolean().default(false),
          unregistered: z.boolean().default(false),
        }),
        outputSchema: z.object({ total: z.number() }),
        handler: async (context) => {
          const client = await dataStreams.initializeClient<typeof dataStreamMappings>(
            context.input.unregistered ? '.task-process-undeclared-data' : TASK_DATA_STREAM_NAME
          );
          const { spaceId } = context.contextManager.getFakeRequest();
          if (context.input.write) {
            const response = await client.create({
              space: spaceId,
              refresh: 'wait_for',
              documents: [
                {
                  '@timestamp': new Date().toISOString(),
                  marker: context.contextManager.getContext().execution.id,
                },
              ],
            });
            if (response.errors) throw new Error('The fixture data stream write failed');
          }
          const response = await client.search({ space: spaceId, size: 0, track_total_hits: true });
          const total = response.hits.total;
          if (total === undefined) throw new Error('The fixture search did not return a total');
          return { output: { total: typeof total === 'number' ? total : total.value } };
        },
      })
    );
  },
};
