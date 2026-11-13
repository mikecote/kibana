/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Readable } from 'stream';
import { fromEvent } from 'rxjs';
import { createFilesRunServices } from '@kbn/files-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import { constructFileKindIdByOwner } from '../../../../common/files';
import { createCaseFileKinds } from '../../../files';
import type { CasesTaskProcessSettings } from '../../cases_task_process_settings';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host: taskHost, settings, logger }) => {
    const host = taskHost as TaskHost;
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.cases.storeFile',
        label: 'Store a native case file',
        category: StepCategory.KibanaCases,
        description: 'Uploads evidence using the native scoped file service',
        inputSchema: z.object({ case_id: z.string().max(256) }),
        outputSchema: z.object({
          file_id: z.string().max(256),
          bytes: z.number(),
          chunks: z.number(),
        }),
        handler: async (context) => {
          context.abortSignal.throwIfAborted();
          const snapshot = (settings.cases as CasesTaskProcessSettings | undefined)?.workflows;
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!snapshot || !security) throw new Error('Native Cases file configuration is missing');
          const { fileServiceFactory } = createFilesRunServices({
            savedObjects: host.savedObjects,
            esClient: host.elasticsearch.asInternalUser,
            security,
            logger,
            analytics: host.analytics,
            usageCounter: host.usageCounters?.getUsageCounter('files'),
            fileKinds: Object.values(
              createCaseFileKinds(snapshot.config.files, host.security.fips.isEnabled())
            ),
          });
          const file = await fileServiceFactory
            .asScoped(context.contextManager.getFakeRequest())
            .create({
              fileKind: constructFileKindIdByOwner('securitySolution'),
              name: 'evidence.txt',
              mime: 'text/plain',
              meta: { caseIds: [context.input.case_id], owner: ['securitySolution'] },
            });
          const uploaded = await file.uploadContent(
            Readable.from([Buffer.from('Evidence uploaded by the worker')]),
            fromEvent(context.abortSignal, 'abort')
          );
          const { size } = uploaded.data;
          if (typeof size !== 'number')
            throw new Error('Native evidence upload has no stored size');
          await host.elasticsearch.asInternalUser.indices.refresh({
            index: '.kibana_blob_storage',
          });
          const { count } = await host.elasticsearch.asInternalUser.count({
            index: '.kibana_blob_storage',
          });
          return { output: { file_id: file.id, bytes: size, chunks: count } };
        },
      })
    );
  },
};
