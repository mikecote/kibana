/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, IClusterClient } from '@kbn/core/server';
import type { EntitySourcesServices } from '../../../../lib/entity_analytics/watchlists/entity_sources/entity_sources_service';
import type { SecurityEntityToolServices } from '../entity_services';

type EntityStart = Awaited<ReturnType<SecurityEntityToolServices['getStartServices']>>;
type SourceStart = Awaited<ReturnType<EntitySourcesServices['getStartServices']>>;

/** Services consumed by watchlist source tools and their background synchronization. */
export interface SecurityWatchlistToolServices extends SecurityEntityToolServices {
  trackBackgroundTask?: (task: Promise<void>) => void;
  getStartServices: () => Promise<
    [
      EntityStart[0] &
        Pick<CoreStart, 'security'> & {
          savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'>;
          elasticsearch: { client: Pick<IClusterClient, 'asInternalUser' | 'asScoped'> };
        },
      EntityStart[1] & SourceStart[1],
      object?
    ]
  >;
}
