/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import {
  createProductDocReadServices,
  PRODUCT_DOC_READ_SETTINGS_ID,
  productDocReadSavedObjectTypes,
} from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import type { ProductDocReadSettings } from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const contribution: WorkflowStepsContribution = {
  declares: {
    savedObjectTypes: productDocReadSavedObjectTypes,
    settings: [PRODUCT_DOC_READ_SETTINGS_ID],
    schedulableTypes: [/^ProductDocBase:/],
  },
  register: (registry, { host, settings }) => {
    const taskHost = host as TaskHost;
    if (!taskHost.taskManager) throw new Error('Native documentation status requires Task Manager');
    const reader = createProductDocReadServices({
      esClient: taskHost.elasticsearch.asInternalUser,
      createInternalRepository: (types) => taskHost.savedObjects.createInternalRepository(types),
      logger: taskHost.logger,
      taskManager: taskHost.taskManager,
      settings: settings[PRODUCT_DOC_READ_SETTINGS_ID] as ProductDocReadSettings,
      kibanaVersion: taskHost.server.version,
      isServerless: taskHost.server.isServerless,
    });
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.sdk.product_doc_status',
        label: 'Read native documentation status',
        description:
          'Read persisted installation tasks and Security Labs status through native SDKs',
        category: StepCategory.Kibana,
        inputSchema: z.object({ inferenceId: z.string() }),
        outputSchema: z.object({
          documentation: z.string(),
          labs: z.string(),
          latestVersion: z.string().optional(),
          isUpdateAvailable: z.boolean().optional(),
        }),
        handler: async ({ input }) => {
          const [documentation, labs] = await Promise.all([
            reader.getStatus(input),
            reader.getSecurityLabsStatus(input),
          ]);
          return {
            output: {
              documentation: documentation.status,
              labs: labs.status,
              latestVersion: labs.latestVersion,
              isUpdateAvailable: labs.isUpdateAvailable,
            },
          };
        },
      })
    );
  },
};
