/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { createConfig } from '../config';
import type { MonitoringConfigSchema } from '../types';
import { Globals } from '../static_globals';
import type { BaseRule } from '../rules/base_rule';

/** What the monitoring plugin gives its rule types in a task process, as `settings.monitoring`. */
export interface MonitoringTaskProcessSettings {
  config: MonitoringConfigSchema;
  isCloud: boolean;
}

/**
 * The task type of one of the stack monitoring rule types. They share a static `Globals` object
 * that the plugin sets up in Kibana; a task process sets it up from the same config.
 */
export const createMonitoringRuleTaskType = (ruleTypeId: string, createRule: () => BaseRule) =>
  createRuleTaskType({
    ruleTypeId,
    getRuleType: ({ logger, publicBaseUrl, settings }) => {
      const monitoring = settings.monitoring as MonitoringTaskProcessSettings;
      Globals.init({
        initializerContext: {},
        config: createConfig(monitoring.config),
        getLogger: (...scopes: string[]) => logger.get(...scopes),
        log: logger,
        coreSetup: { http: { basePath: { publicBaseUrl } } },
        setupPlugins: { cloud: { isCloudEnabled: monitoring.isCloud } },
      } as never);
      return createRule().getRuleType() as never;
    },
  });
