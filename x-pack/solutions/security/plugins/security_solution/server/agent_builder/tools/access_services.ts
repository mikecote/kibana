/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { SecurityCoreToolServices } from './core_services';

type CoreToolStart = Awaited<ReturnType<SecurityCoreToolServices['getStartServices']>>;

/** The authorization and license readers consumed by Security's assessment tools. */
export interface SecurityAccessToolServices extends SecurityCoreToolServices {
  getStartServices: () => Promise<
    [
      CoreToolStart[0],
      CoreToolStart[1] & {
        licensing: Pick<LicensingPluginStart, 'getLicense'>;
        security: Pick<SecurityPluginStart, 'authz'>;
      },
      object?
    ]
  >;
}
