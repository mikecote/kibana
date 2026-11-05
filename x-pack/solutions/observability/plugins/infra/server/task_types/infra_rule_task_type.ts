/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsType } from '@kbn/core/server';
import type { UiSettingsParams } from '@kbn/core-ui-settings-common';
import type { AlertingServerSetup } from '@kbn/alerting-plugin/server';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import type { RuleTaskTypeOptions } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { getRuleTypeFromRegistration } from '@kbn/alerting-plugin/server/task_types/capture_rule_type';
import { MetricsDataClient } from '@kbn/metrics-data-access-plugin/server';
import { metricsDataSourceSavedObjectType } from '@kbn/metrics-data-access-plugin/server/saved_objects/metrics_data_source';
import { logViewSavedObjectType } from '@kbn/logs-shared-plugin/server/saved_objects/log_view';
import { uiSettings as logsDataAccessUiSettings } from '@kbn/logs-data-access-plugin/common/ui_settings';
import {
  ASSET_DETAILS_LOCATOR_ID,
  AssetDetailsLocatorDefinition,
  INVENTORY_LOCATOR_ID,
  InventoryLocatorDefinition,
  METRICS_EXPLORER_LOCATOR_ID,
  MetricsExplorerLocatorDefinition,
} from '@kbn/observability-shared-plugin/common';
import type {
  AssetDetailsLocator,
  InventoryLocator,
  MetricsExplorerLocator,
} from '@kbn/observability-shared-plugin/common';
import type { InfraConfig } from '../types';
import {
  createInfraAlertingLibs,
  createInfraSources,
  createLogViewsClientGetter,
} from '../lib/alerting/create_infra_alerting_libs';
import type { InfraAlertingLibs } from '../lib/alerting/create_infra_alerting_libs';
import type { InfraLocators } from '../lib/infra_types';
import { infraSourceConfigurationSavedObjectType } from '../lib/sources';

/** The saved objects the sources of infra read: its source configuration and the metric indices. */
const SOURCES_SAVED_OBJECT_TYPES: SavedObjectsType[] = [
  infraSourceConfigurationSavedObjectType,
  metricsDataSourceSavedObjectType,
];
/** What resolving a log view reads, besides the sources. */
const LOG_VIEW_SAVED_OBJECT_TYPES: SavedObjectsType[] = [logViewSavedObjectType];

type RegisterInfraRuleType = (
  alerting: AlertingServerSetup,
  libs: InfraAlertingLibs,
  config: InfraConfig,
  locators: InfraLocators
) => void;

/**
 * The task type of one of the infra rule types. They have no factory of their own: the plugin
 * registers each through a function that takes its libs and locators, so this runs that function
 * against a stand-in for the alerting contract that keeps the rule type, with libs built from the
 * host the way the plugin builds them from Kibana's services.
 */
export const createInfraRuleTaskType = (
  ruleTypeId: string,
  register: RegisterInfraRuleType,
  { readsLogViews = false }: { readsLogViews?: boolean } = {}
) => {
  const options: RuleTaskTypeOptions & {
    /** The ui settings the rule reads, with their defaults. */
    uiSettings?: Array<Record<string, UiSettingsParams>>;
  } = {
    locators: [
      new AssetDetailsLocatorDefinition(),
      new MetricsExplorerLocatorDefinition(),
      new InventoryLocatorDefinition(),
    ],
    savedObjectTypes: [
      ...SOURCES_SAVED_OBJECT_TYPES,
      ...(readsLogViews ? LOG_VIEW_SAVED_OBJECT_TYPES : []),
    ],
    ...(readsLogViews ? { uiSettings: [logsDataAccessUiSettings] } : {}),
  };

  return createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: ({ logger, publicBaseUrl, isServerless, settings, locators, runtime }) => {
        const configuration = settings.infra as InfraConfig;
        const sources = createInfraSources({ metricsClient: new MetricsDataClient() });
        const libs = createInfraAlertingLibs({
          logger,
          basePath: { publicBaseUrl },
          configuration,
          sources,
          // The runtime does not exist yet while the rule type is built, so it is read when a rule runs.
          getLogViewsClient: createLogViewsClientGetter({
            logger,
            sources,
            configuration,
            isServerless,
            getServices: () => runtime,
          }),
        });
        return getRuleTypeFromRegistration((alerting) =>
          register(alerting as AlertingServerSetup, libs, configuration, {
            assetDetailsLocator: locators.get(ASSET_DETAILS_LOCATOR_ID) as AssetDetailsLocator,
            metricsExplorerLocator: locators.get(
              METRICS_EXPLORER_LOCATOR_ID
            ) as MetricsExplorerLocator,
            inventoryLocator: locators.get(INVENTORY_LOCATOR_ID) as InventoryLocator,
          })
        );
      },
    },
    options
  );
};
