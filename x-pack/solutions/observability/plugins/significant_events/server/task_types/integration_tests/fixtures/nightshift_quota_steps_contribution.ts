/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { NightshiftInvestigationQuotaService } from '@kbn/nightshift-investigations-plugin/server';
import {
  createRunQuotaInternalRepository,
  patchRunQuotaSettings,
  getRunQuotaLedgerId,
} from '../../../lib/run_quotas/repository';
import { RUN_QUOTA_LEDGER_SO_TYPE } from '../../../lib/run_quotas/saved_objects';
import type { RunQuotaLedgerAttributes } from '../../../lib/run_quotas/saved_objects';
import { dayKey, resolveDailyWindow } from '../../../lib/run_quotas/window';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host: taskHost, services }) => {
    if (!services) throw new Error('Quota proof requires native workflow services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.nightshift.quota',
        label: 'Native investigation quota proof',
        description: 'Consumes the native investigation quota and reads its durable ledger.',
        category: StepCategory.Ai,
        inputSchema: z.object({}),
        outputSchema: z.object({ allowed: z.boolean(), count: z.number() }),
        handler: async () => {
          const host = taskHost as TaskHost;
          const repository = createRunQuotaInternalRepository({
            core: { savedObjects: host.savedObjects },
          });
          await patchRunQuotaSettings(repository, { enabled: true, limits: { investigation: 1 } });
          const { allowed } = await services
            .getService<NightshiftInvestigationQuotaService>('nightshift.investigationQuota')
            .consume();
          const ledger = await repository.get<RunQuotaLedgerAttributes>(
            RUN_QUOTA_LEDGER_SO_TYPE,
            getRunQuotaLedgerId(dayKey(resolveDailyWindow()), 'investigation')
          );
          return { output: { allowed, count: ledger.attributes.count } };
        },
      })
    );
  },
};
