/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, KibanaRequest } from '@kbn/core/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { MitreAttackServerStart } from '@kbn/mitre-attack-plugin/server';
import type { RulesClient } from '@kbn/alerting-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import type { SecurityCoreToolServices } from './core_services';

type CoreToolStart = Awaited<ReturnType<SecurityCoreToolServices['getStartServices']>>;

/** Services consumed when generating a draft detection rule attachment. */
export interface SecurityRuleCreationServices extends SecurityCoreToolServices {
  getStartServices: () => Promise<
    [
      CoreToolStart[0] & { savedObjects: Pick<CoreStart['savedObjects'], 'getScopedClient'> },
      CoreToolStart[1] & {
        security: Pick<SecurityPluginStart, 'authz'>;
        inference: InferenceServerStart;
        alerting: {
          getRulesClientWithRequest: (request: KibanaRequest) => Promise<Pick<RulesClient, 'find'>>;
        };
        mitreAttack?: MitreAttackServerStart;
      },
      object?
    ]
  >;
}
