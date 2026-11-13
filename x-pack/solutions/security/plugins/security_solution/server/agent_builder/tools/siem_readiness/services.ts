/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, KibanaRequest } from '@kbn/core/server';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type { RulesClient } from '@kbn/alerting-plugin/server';
import type { SecurityCoreToolServices } from '../core_services';

type CoreToolStart = Awaited<ReturnType<SecurityCoreToolServices['getStartServices']>>;

/** Services used to build readiness findings from current rules and data views. */
export interface SecurityReadinessToolServices extends SecurityCoreToolServices {
  getStartServices: () => Promise<
    [
      CoreToolStart[0] & { savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'> },
      CoreToolStart[1] & {
        alerting: {
          getRulesClientWithRequest: (request: KibanaRequest) => Promise<Pick<RulesClient, 'find'>>;
        };
        dataViews: Pick<DataViewsServerPluginStart, 'dataViewsServiceFactory'>;
      },
      object?
    ]
  >;
}
