/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable } from 'rxjs';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { PublicFrameworkAlertsService, DataStreamAdapter } from '@kbn/alerting-plugin/server';
import type { RuleRegistryPluginConfig } from '../config';
import { RuleDataService } from './rule_data_plugin_service';

export interface RuleDataServiceDeps {
  logger: Logger;
  kibanaVersion: string;
  /** The validated config of the plugin, `xpack.ruleRegistry`. */
  config: RuleRegistryPluginConfig;
  getClusterClient: () => Promise<ElasticsearchClient>;
  frameworkAlerts: PublicFrameworkAlertsService;
  pluginStop$: Observable<void>;
  dataStreamAdapter: DataStreamAdapter;
  elasticsearchAndSOAvailability$: Observable<boolean>;
}

/**
 * The rule data service, initialized, built from explicit dependencies: Kibana builds it with the
 * plugin's own services, a task process with the ones of its host. Initializing it installs the
 * common resources the way every start of Kibana does; the installers compare content hashes with
 * what is installed, so they write nothing when the resources are up to date.
 */
export const createRuleDataService = ({
  logger,
  kibanaVersion,
  config,
  getClusterClient,
  frameworkAlerts,
  pluginStop$,
  dataStreamAdapter,
  elasticsearchAndSOAvailability$,
}: RuleDataServiceDeps): RuleDataService => {
  const ruleDataService = new RuleDataService({
    logger,
    kibanaVersion,
    disabledRegistrationContexts: config.write.disabledRegistrationContexts,
    isWriteEnabled: config.write.enabled,
    isWriterCacheEnabled: config.write.cache.enabled,
    getClusterClient,
    frameworkAlerts,
    pluginStop$,
    dataStreamAdapter,
    elasticsearchAndSOAvailability$,
  });
  ruleDataService.initializeService();
  return ruleDataService;
};
