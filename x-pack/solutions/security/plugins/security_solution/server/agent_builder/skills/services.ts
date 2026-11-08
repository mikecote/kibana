/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { FleetStartContract } from '@kbn/fleet-plugin/server';
import type { SecurityAccessToolServices } from '../tools/access_services';
import type { SecurityReadinessToolServices } from '../tools/siem_readiness/services';

type AccessStart = Awaited<ReturnType<SecurityAccessToolServices['getStartServices']>>;
type ReadinessStart = Awaited<ReturnType<SecurityReadinessToolServices['getStartServices']>>;

/** Core and plugin readers consumed by Security's analytical skill tools. */
export interface SecuritySkillServices {
  getStartServices: () => Promise<
    [
      AccessStart[0] & ReadinessStart[0],
      AccessStart[1] &
        ReadinessStart[1] & {
          fleet?: {
            packageService: {
              asScoped: (
                request: KibanaRequest
              ) => Pick<
                ReturnType<FleetStartContract['packageService']['asScoped']>,
                'getPackages'
              >;
            };
          };
        },
      object?
    ]
  >;
}
