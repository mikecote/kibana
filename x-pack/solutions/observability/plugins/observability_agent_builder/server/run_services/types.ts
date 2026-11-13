/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { ApmDataAccessPluginSetup } from '@kbn/apm-data-access-plugin/server';
import type { LogsDataAccessPluginStart } from '@kbn/logs-data-access-plugin/server';
import type { MetricsDataPluginSetup } from '@kbn/metrics-data-access-plugin/server';
import type { MlPluginSetup } from '@kbn/ml-plugin/server';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { RuleRegistryPluginStartContract } from '@kbn/rule-registry-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';

export interface ObservabilityAgentBuilderRunSetupDependencies {
  agentBuilder: Pick<AgentBuilderPluginSetup, 'tools' | 'attachments' | 'skills'>;
  apmDataAccess: Pick<ApmDataAccessPluginSetup, 'getApmIndices' | 'getServices'>;
  metricsDataAccess: {
    client: Pick<MetricsDataPluginSetup['client'], 'getMetricIndices'>;
  };
  ml?: Pick<MlPluginSetup, 'mlSystemProvider'>;
}

export interface ObservabilityAgentBuilderRunStartDependencies {
  logsDataAccess: {
    services: {
      logSourcesServiceFactory: Pick<
        LogsDataAccessPluginStart['services']['logSourcesServiceFactory'],
        'getLogSourcesService'
      >;
    };
  };
  licensing: Pick<LicensingPluginStart, 'license$'>;
  ruleRegistry: Pick<RuleRegistryPluginStartContract, 'getRacClientWithRequest'>;
  spaces?: {
    spacesService: Pick<SpacesPluginStart['spacesService'], 'getActiveSpace'>;
  };
}

export interface ObservabilityAgentBuilderRunCore {
  getStartServices: () => Promise<
    [
      {
        elasticsearch: { client: Pick<CoreStart['elasticsearch']['client'], 'asScoped'> };
        savedObjects: Pick<
          CoreStart['savedObjects'],
          'getScopedClient' | 'createInternalRepository'
        >;
      },
      ObservabilityAgentBuilderRunStartDependencies,
      Record<string, never>
    ]
  >;
}
