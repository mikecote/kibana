/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// TODO: https://github.com/elastic/kibana/issues/110907

import type { PluginInitializerContext } from '@kbn/core/server';

export type { RuleRegistryPluginSetupContract, RuleRegistryPluginStartContract } from './plugin';
export type {
  RacRequestHandlerContext,
  RacApiRequestHandlerContext,
  AlertTypeWithExecutor,
} from './types';

export type { RuleRegistryPluginConfig } from './config';
export {
  createRuleDataTaskProcessService,
  RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID,
} from './task_types/rule_data_task_process_services';
export { config, INDEX_PREFIX } from './config';
export { getNamespacedRuleDataAlias } from './rule_data_plugin_service/get_namespaced_rule_data_alias';
export type {
  IRuleDataService,
  RuleDataPluginService,
  IndexOptions,
  Settings,
  Mappings,
  Version,
  Meta,
  ComponentTemplateOptions,
  IndexTemplateOptions,
  IlmPolicyOptions,
} from './rule_data_plugin_service';
export {
  RuleDataService,
  createRuleDataService,
  Dataset,
  RuleDataWriteDisabledError,
  RuleDataWriterInitializationError,
} from './rule_data_plugin_service';
export type { RuleDataClientConstructorOptions, WaitResult } from './rule_data_client';
export type { IRuleDataClient, IRuleDataReader, IRuleDataWriter } from './rule_data_client/types';
export { RuleDataClient } from './rule_data_client';

export { createPersistenceRuleTypeWrapper } from './utils/create_persistence_rule_type_wrapper';
export type {
  PersistenceAlertService,
  SuppressedAlertService,
  SuppressedAlertServiceResult,
  PersistenceAlertServiceResult,
  PersistenceServices,
  PersistenceAlertType,
  CreatePersistenceRuleTypeWrapper,
} from './utils/persistence_types';
export type { AlertsClient } from './alert_data_client/alerts_client';

export const plugin = async (initContext: PluginInitializerContext) => {
  const { RuleRegistryPlugin } = await import('./plugin');
  return new RuleRegistryPlugin(initContext);
};
