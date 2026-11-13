/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';

export const contribution: WorkflowStepsContribution = {
  declares: {
    featureFlags: {
      'test.sdk.enabled': false,
      'test.sdk.limit': 12.5,
      'test.sdk.mode': 'true',
    },
  },
  register: (registry, { host }) => {
    const { featureFlags, elasticsearch } = host as Pick<
      TaskHost,
      'featureFlags' | 'elasticsearch'
    >;
    if (!featureFlags) throw new Error('The native SDK requires feature flags');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.sdk.feature_flags',
        label: 'Use native SDK flags',
        description: 'Execute a scoped operation only when the dispatching Main enables it',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({ enabled: z.boolean(), limit: z.number(), mode: z.string() }),
        handler: async (context) => {
          const [enabled, limit, mode] = await Promise.all([
            firstValueFrom(featureFlags.getBooleanValue$('test.sdk.enabled', false)),
            firstValueFrom(featureFlags.getNumberValue$('test.sdk.limit', 12.5)),
            firstValueFrom(featureFlags.getStringValue$('test.sdk.mode', 'true')),
          ]);
          if (enabled) {
            await elasticsearch
              .asScoped(context.contextManager.getFakeRequest())
              .asCurrentUser.index({
                index: 'native-sdk-feature-effects',
                document: { limit, mode },
                refresh: 'wait_for',
              });
          }
          return { output: { enabled, limit, mode } };
        },
      })
    );
  },
};
