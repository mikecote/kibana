/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, KibanaRequest } from '@kbn/core/server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { ScheduledWorkflowsExtensions } from '@kbn/discoveries/impl/attack_discovery/workflow_executor_contribution';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';

/**
 * What the steps read of Core, and nothing else: Core's start contract has all of it, and a task
 * process builds it from its host.
 */
export interface DiscoveriesStepCoreServices {
  elasticsearch: { client: Pick<CoreStart['elasticsearch']['client'], 'asScoped'> };
  featureFlags: Pick<CoreStart['featureFlags'], 'getBooleanValue$'>;
  http: { basePath: Pick<CoreStart['http']['basePath'], 'get'> };
  savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'>;
  security: {
    authc: {
      apiKeys: Pick<
        CoreStart['security']['authc']['apiKeys'],
        'grantAsInternalUser' | 'invalidateAsInternalUser'
      >;
    };
  };
  uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient'>;
}

/** What the steps read of the plugins they depend on: their start contracts, or what a process builds. */
export interface DiscoveriesStepPluginServices {
  actions: Pick<ActionsPluginStart, 'getActionsClientWithRequest'>;
  inference?: InferenceServerStart;
  searchInferenceEndpoints?: SearchInferenceEndpointsPluginStart;
  security: Pick<SecurityPluginStart, 'authz'>;
  spaces?: { spacesService: { getSpaceId: (request: KibanaRequest) => string } };
  workflowsExtensions: ScheduledWorkflowsExtensions;
}

/**
 * Where the steps get their services: `plugin.ts` reads them from the start contracts, and the task
 * process of the workflow task types builds them from its host (`workflow_steps_contribution.ts`).
 */
export type GetStepServices = () => Promise<{
  coreStart: DiscoveriesStepCoreServices;
  pluginsStart: DiscoveriesStepPluginServices;
}>;
