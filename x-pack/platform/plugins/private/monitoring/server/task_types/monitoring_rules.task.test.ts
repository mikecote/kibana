/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { configSchema } from '../config';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { Globals } from '../static_globals';
import { RulesFactory } from '../rules/rules_factory';
import { taskType as clusterHealth } from './cluster_health.task';
import { taskType as largeShardSize } from './large_shard_size.task';
import { taskType as cpuUsage } from './cpu_usage.task';
import { createConfig } from '../config';

describe('monitoring task type modules', () => {
  const settings = {
    monitoring: { config: configSchema.validate({}), isCloud: false },
  };

  beforeAll(() => {
    // What the plugin sets up in Kibana, so the rule types it registers can be built here.
    Globals.init({
      initializerContext: {},
      config: createConfig(settings.monitoring.config),
      getLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
      log: {},
      coreSetup: { http: { basePath: { publicBaseUrl: 'https://kibana.test' } } },
      setupPlugins: { cloud: { isCloudEnabled: false } },
    } as never);
  });

  it.each([
    ['cluster health', clusterHealth],
    ['large shard size', largeShardSize],
    ['cpu usage', cpuUsage],
  ])('builds the %s rule type that the plugin registers', (_name, taskType) => {
    const registered = RulesFactory.getAll()
      .map((rule) => rule.getRuleType())
      .find((ruleType) => `alerting:${ruleType.id}` === taskType.type)!;
    expectModuleToMatchRegisteredRuleType(taskType, registered as never, settings);
  });
});
