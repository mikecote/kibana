/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, IClusterClient, StartServicesAccessor } from '@kbn/core/server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type { StandaloneSearch } from '@kbn/data-plugin/server/search/standalone_search';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { SharePluginStart } from '@kbn/share-plugin/server';

/** Scoped services consumed by the shared rule preview executor. */
export interface RulePreviewServices {
  getStartServices: () => Promise<
    [
      {
        elasticsearch: { client: Pick<IClusterClient, 'asScoped' | 'asInternalUser'> };
        uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient'>;
      },
      {
        data: { search: Pick<StandaloneSearch, 'searchSource' | 'asScoped'> };
        security: Pick<SecurityPluginStart, 'authz'>;
        share: SharePluginStart;
        dataViews: Pick<DataViewsServerPluginStart, 'dataViewsServiceFactory'>;
        actions: Pick<ActionsPluginStart, 'getActionsClientWithRequest'>;
        licensing: Pick<LicensingPluginStart, 'getLicense'>;
      },
      pluginStart?: Awaited<ReturnType<StartServicesAccessor>>[2]
    ]
  >;
}
