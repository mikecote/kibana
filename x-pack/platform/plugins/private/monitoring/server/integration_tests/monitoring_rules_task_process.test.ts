/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { startRuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { configSchema } from '../config';
import { taskType as cpuUsage } from '../task_types/cpu_usage.task';
import { taskType as clusterHealth } from '../task_types/cluster_health.task';
import { taskType as licenseExpiration } from '../task_types/license_expiration.task';
import { taskType as missingMonitoringData } from '../task_types/missing_monitoring_data.task';
import { taskType as diskUsage } from '../task_types/disk_usage.task';
import { taskType as threadPoolSearchRejections } from '../task_types/thread_pool_search_rejections.task';
import { taskType as threadPoolWriteRejections } from '../task_types/thread_pool_write_rejections.task';
import { taskType as memoryUsage } from '../task_types/memory_usage.task';
import { taskType as nodesChanged } from '../task_types/nodes_changed.task';
import { taskType as logstashVersionMismatch } from '../task_types/logstash_version_mismatch.task';
import { taskType as kibanaVersionMismatch } from '../task_types/kibana_version_mismatch.task';
import { taskType as elasticsearchVersionMismatch } from '../task_types/elasticsearch_version_mismatch.task';
import { taskType as ccrReadExceptions } from '../task_types/ccr_read_exceptions.task';
import { taskType as largeShardSize } from '../task_types/large_shard_size.task';

const MODULES = [
  [cpuUsage, 'monitoring__cpu_usage'],
  [clusterHealth, 'monitoring__cluster_health'],
  [licenseExpiration, 'monitoring__license_expiration'],
  [missingMonitoringData, 'monitoring__missing_monitoring_data'],
  [diskUsage, 'monitoring__disk_usage'],
  [threadPoolSearchRejections, 'monitoring__thread_pool_search_rejections'],
  [threadPoolWriteRejections, 'monitoring__thread_pool_write_rejections'],
  [memoryUsage, 'monitoring__memory_usage'],
  [nodesChanged, 'monitoring__nodes_changed'],
  [logstashVersionMismatch, 'monitoring__logstash_version_mismatch'],
  [kibanaVersionMismatch, 'monitoring__kibana_version_mismatch'],
  [elasticsearchVersionMismatch, 'monitoring__elasticsearch_version_mismatch'],
  [ccrReadExceptions, 'monitoring__ccr_read_exceptions'],
  [largeShardSize, 'monitoring__large_shard_size'],
] as const;

/**
 * The 14 stack monitoring rule types, each from its own bundle forked the way Kibana does, against
 * Elasticsearch with no monitoring data: every run must be served by the process (never declined to
 * Kibana) and finish with a successful `execute` event, as a run in Kibana's own runtime does.
 */
// What each rule type stores as its params when it is created, as its `defaultParams` say.
const PARAMS_BY_TYPE: Record<string, Record<string, unknown>> = {
  'alerting:monitoring_alert_missing_monitoring_data': { duration: '15m', limit: '1d' },
  'alerting:monitoring_shard_size': { indexPattern: '-.*', threshold: 55 },
};

describe('the stack monitoring rule types served from bundles', () => {
  let harness: RuleProcessHarness;

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: MODULES.map(([taskType, bundle]) => ({ taskType, bundle })),
      // What Kibana sends for the monitoring plugin.
      settings: { monitoring: { config: configSchema.validate({}), isCloud: false } },
    });
    for (const [taskType] of MODULES) {
      await harness.createRule({
        id: taskType.type,
        ruleTypeId: taskType.type.replace('alerting:', ''),
        consumer: 'monitoring',
        params: PARAMS_BY_TYPE[taskType.type] ?? { threshold: 85, duration: '5m' },
      });
    }
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it.each(MODULES.map(([taskType]) => [taskType.type]))(
    'runs %s in the process to a successful execution, as Kibana does',
    async (type) => {
      const ruleTypeId = type.replace('alerting:', '');
      const { result, fallback } = await harness.run(type, ruleTypeId);
      expect(fallback).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('taskRunError');

      const events = await harness.getEventDocs(type);
      const execute = events.find((doc) => doc.event.action === 'execute');
      expect(execute?.event.outcome).toBe('success');
    }
  );
});
