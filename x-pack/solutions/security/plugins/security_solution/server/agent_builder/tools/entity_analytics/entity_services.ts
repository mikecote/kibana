/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { MitreAttackServerStart } from '@kbn/mitre-attack-plugin/server';
import type { CoreStart } from '@kbn/core/server';
import type { EntityStoreClientServices } from '@kbn/entity-store/server/create_entity_store_client_services';
import type { EntityStoreRunServices } from '@kbn/entity-store/server/entity_store_run_services';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { SecurityCoreToolServices } from '../core_services';

type CoreToolStart = Awaited<ReturnType<SecurityCoreToolServices['getStartServices']>>;

/** The native entity, authorization and telemetry services consumed by Security's entity tools. */
export interface SecurityEntityToolServices extends SecurityCoreToolServices {
  getStartServices: () => Promise<
    [
      CoreToolStart[0] & { analytics: Pick<CoreStart['analytics'], 'reportEvent'> },
      CoreToolStart[1] & {
        entityStore: EntityStoreClientServices & EntityStoreRunServices;
        licensing: Pick<LicensingPluginStart, 'getLicense'>;
        security: Pick<SecurityPluginStart, 'authz'>;
      },
      object?
    ]
  >;
}

/** Adds the managed MITRE reader used by enriched entity profiles. */
export interface SecurityEntityEnrichmentServices extends SecurityEntityToolServices {
  getStartServices: () => Promise<
    [
      Awaited<ReturnType<SecurityEntityToolServices['getStartServices']>>[0],
      Awaited<ReturnType<SecurityEntityToolServices['getStartServices']>>[1] & {
        mitreAttack?: MitreAttackServerStart;
      },
      object?
    ]
  >;
}
