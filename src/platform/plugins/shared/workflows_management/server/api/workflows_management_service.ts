/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CoreSetup, CoreStart, Logger } from '@kbn/core/server';
import { waitForManagedWorkflowInstallReadiness } from '../lib/wait_for_managed_workflow_install_readiness';
import { WorkflowsRuntime } from '../runtime/workflows_runtime';
import type { WorkflowsServerPluginSetupDeps, WorkflowsServerPluginStartDeps } from '../types';

export type {
  SearchExecutionsViewParams,
  SearchWorkflowExecutionsParams,
} from '../runtime/workflows_runtime';

export class WorkflowsService extends WorkflowsRuntime<CoreStart> {
  constructor(
    public readonly core: CoreSetup<WorkflowsServerPluginStartDeps>,
    public readonly plugins: WorkflowsServerPluginSetupDeps,
    logger: Logger,
    kibanaVersion: string
  ) {
    super(
      {
        getStartServices: async () => {
          const [coreStart, pluginsStart] = await core.getStartServices();
          return { core: coreStart, ...pluginsStart };
        },
        getSpaceId: (request) => plugins.spaces.spacesService.getSpaceId(request),
        waitUntilReady: async (signal, operation) => {
          const [coreStart] = await core.getStartServices();
          return waitForManagedWorkflowInstallReadiness({
            core$: core.status.core$,
            esClient: { ping: () => coreStart.elasticsearch.client.asInternalUser.ping() },
            signal,
            operation,
            logger,
          });
        },
      },
      logger,
      kibanaVersion
    );
  }
}
