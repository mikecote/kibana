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
import {
  METRIC_INVENTORY_THRESHOLD_ALERT_TYPE_ID,
  LOG_THRESHOLD_ALERT_TYPE_ID,
  METRIC_THRESHOLD_ALERT_TYPE_ID,
} from '@kbn/rule-data-utils';
import { config as infraConfigDescriptor } from '../config';
import { taskType as metricThreshold } from '../task_types/metric_threshold.task';
import { taskType as inventoryMetricThreshold } from '../task_types/inventory_metric_threshold.task';
import { taskType as logThreshold } from '../task_types/log_threshold.task';

const METRICS_ALERTS_INDEX = '.alerts-observability.metrics.alerts-*';
const LOGS_ALERTS_INDEX = '.alerts-observability.logs.alerts-*';
// Match the default metric indices (`metrics-*,metricbeat-*`) and log sources (`filebeat-*`) without being data streams.
const METRIC_INDEX = 'metricbeat-infra-test';
const HOST_INDEX = 'metricbeat-infra-hosts';
const LOG_INDEX = 'filebeat-infra-test';
const LOG_VIEW_REFERENCES = [
  { id: 'default', name: 'param:log-view-reference-0', type: 'infrastructure-monitoring-log-view' },
];

/**
 * The infra rule types (metric threshold, inventory and log threshold) from their own bundles, forked
 * the way Kibana does, against a real Elasticsearch with a few metric and log documents. Each run is
 * compared with the same rule run in the test process, as Kibana's runtime does.
 */
describe('the infra rule types served from bundles', () => {
  let harness: RuleProcessHarness;

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [
        { taskType: metricThreshold, bundle: 'infra__metric_threshold' },
        { taskType: inventoryMetricThreshold, bundle: 'infra__inventory_metric_threshold' },
        { taskType: logThreshold, bundle: 'infra__log_threshold' },
      ],
      // What Kibana sends for the infra rule types: the config of infra.
      settings: { infra: infraConfigDescriptor.schema.validate({}) },
      indices: {
        [HOST_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            'host.name': { type: 'keyword' },
            'event.module': { type: 'keyword' },
            'event.dataset': { type: 'keyword' },
            'metricset.name': { type: 'keyword' },
            'system.cpu.total.norm.pct': { type: 'float' },
            'system.cpu.cores': { type: 'long' },
          },
        },
        [LOG_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            message: { type: 'text' },
            'log.level': { type: 'keyword' },
          },
        },
      },
    });
    const now = new Date().toISOString();
    await harness.es.index({
      index: METRIC_INDEX,
      refresh: 'wait_for',
      document: { '@timestamp': now, message: 'hello' },
    });
    await harness.es.index({
      index: HOST_INDEX,
      refresh: 'wait_for',
      document: {
        '@timestamp': now,
        'host.name': 'host-1',
        'event.module': 'system',
        'event.dataset': 'system.cpu',
        'metricset.name': 'cpu',
        'system.cpu.total.norm.pct': 0.9,
        'system.cpu.cores': 4,
      },
    });
    await harness.es.bulk({
      refresh: 'wait_for',
      operations: [1, 2, 3].flatMap((i) => [
        { create: { _index: LOG_INDEX } },
        { '@timestamp': now, message: `failure ${i}`, 'log.level': 'error' },
      ]),
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  const expectServed = (
    forked: Awaited<ReturnType<RuleProcessHarness['runBoth']>>['forked'],
    alerts: number
  ) => {
    expect(forked.alerts).toHaveLength(alerts);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
  };

  it('alerts when the metric threshold is crossed, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'metric-threshold',
        ruleTypeId: METRIC_THRESHOLD_ALERT_TYPE_ID,
        consumer: 'infrastructure',
        params: {
          criteria: [
            { aggType: 'count', comparator: '>', threshold: [0], timeSize: 1, timeUnit: 'h' },
          ],
          sourceId: 'default',
          alertOnNoData: false,
          alertOnGroupDisappear: false,
        },
      },
      METRICS_ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('alerts when the inventory threshold is crossed, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'inventory-threshold',
        ruleTypeId: METRIC_INVENTORY_THRESHOLD_ALERT_TYPE_ID,
        consumer: 'infrastructure',
        params: {
          nodeType: 'host',
          sourceId: 'default',
          criteria: [
            {
              metric: 'cpuV2',
              comparator: '>',
              threshold: [50],
              timeSize: 1,
              timeUnit: 'h',
            },
          ],
        },
      },
      METRICS_ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('alerts when the log count is over the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'log-threshold',
        ruleTypeId: LOG_THRESHOLD_ALERT_TYPE_ID,
        consumer: 'logs',
        params: {
          criteria: [{ field: 'log.level', comparator: 'equals', value: 'error' }],
          count: { comparator: 'more than', value: 1 },
          timeUnit: 'h',
          timeSize: 1,
          logView: { type: 'log-view-reference', logViewId: 'log-view-reference-0' },
        },
        // The default log view is the built-in one: the rule refers to it as Kibana stores it.
        references: LOG_VIEW_REFERENCES,
      },
      LOGS_ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('runs to a success without an alert when the log count stays under the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'log-threshold-quiet',
        ruleTypeId: LOG_THRESHOLD_ALERT_TYPE_ID,
        consumer: 'logs',
        params: {
          criteria: [{ field: 'log.level', comparator: 'equals', value: 'error' }],
          count: { comparator: 'more than', value: 100 },
          timeUnit: 'h',
          timeSize: 1,
          logView: { type: 'log-view-reference', logViewId: 'log-view-reference-0' },
        },
        // The default log view is the built-in one: the rule refers to it as Kibana stores it.
        references: LOG_VIEW_REFERENCES,
      },
      LOGS_ALERTS_INDEX
    );
    expectServed(forked, 0);
    expect(forked).toEqual(inProcess);
  });
});
