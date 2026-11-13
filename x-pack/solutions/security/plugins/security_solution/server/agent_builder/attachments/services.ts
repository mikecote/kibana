/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IClusterClient, KibanaRequest } from '@kbn/core/server';
import type { RulesClient } from '@kbn/alerting-plugin/server';

/** The native scoped services consumed by Security's attachment definitions. */
export interface SecurityAttachmentsServices {
  getStartServices: () => Promise<
    [
      { elasticsearch: { client: Pick<IClusterClient, 'asScoped'> } },
      {
        alerting: {
          getRulesClientWithRequest: (
            request: KibanaRequest
          ) => Promise<Pick<RulesClient, 'find' | 'resolve'>>;
        };
      },
      object?
    ]
  >;
}
