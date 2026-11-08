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

import { createNativePrometheusCollector } from '@kbn/task-manager-plugin/server/task_process/testing/native_prometheus_collector';
import { createNativePrometheusInstrumentation } from '@kbn/task-manager-plugin/server/task_process/testing/native_metrics_instrumentation';
import { createNativeMetricsCollector } from '@kbn/task-manager-plugin/server/task_process/testing/native_metrics_collector';
import { createNativeMetricsInstrumentation } from '@kbn/task-manager-plugin/server/task_process/testing/native_metrics_instrumentation';
import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import {
  DYNAMIC_CONNECTOR,
  KIBANA_UUID,
  startRuleProcessHarness,
} from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { taskType } from '../task_types/es_query.task';

const RULE_TYPE = '.es-query';
const SOURCE_INDEX = 'es-query-source';
const RULE_ID = 'rule-1';
const CASES_RULE_ID = 'rule-with-cases';
const UNKNOWN_RULE_ID = 'rule-with-unknown-action';
const CONNECTOR_ID = 'server-log-1';
const DYNAMIC_RULE_ID = 'rule-with-dynamic-connector';
const ALERTS_INDEX = '.alerts-stack.alerts-default';

const ruleParams = {
  index: [SOURCE_INDEX],
  timeField: '@timestamp',
  esQuery: '{"query":{"match_all":{}}}',
  size: 100,
  timeWindowSize: 1,
  timeWindowUnit: 'h',
  threshold: [0],
  thresholdComparator: '>',
  searchType: 'esQuery',
  excludeHitsFromPreviousRun: false,
  aggType: 'count',
  groupBy: 'all',
};

/**
 * Runs the `.es-query` rule type from its own bundle, forked by the supervisor the way Kibana does,
 * against a real Elasticsearch: the process decrypts the rule with the encryption key it is sent,
 * runs the executor, writes the alert and the event log, and enqueues the action task for Kibana.
 */
describe('the .es-query rule type served from a bundle', () => {
  let harness: RuleProcessHarness;

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'stackAlerts__es_query' }],
    });
    await harness.createConnector(CONNECTOR_ID);
    const serverLog = {
      group: 'query matched',
      actionTypeId: '.server-log',
      connectorId: CONNECTOR_ID,
      params: { level: 'info', message: 'matched {{context.title}}' },
    };
    await harness.createRule({
      id: RULE_ID,
      ruleTypeId: RULE_TYPE,
      params: ruleParams,
      actions: [serverLog],
    });
    await harness.createRule({
      id: CASES_RULE_ID,
      ruleTypeId: RULE_TYPE,
      params: ruleParams,
      actions: [
        {
          ...serverLog,
          actionTypeId: '.cases',
          params: { subAction: 'run', subActionParams: {} },
        },
      ],
    });
    await harness.createRule({
      id: DYNAMIC_RULE_ID,
      ruleTypeId: RULE_TYPE,
      params: ruleParams,
      actions: [
        {
          group: 'query matched',
          actionTypeId: '.server-log',
          inMemoryConnectorId: DYNAMIC_CONNECTOR.id,
          params: { level: 'info', message: 'dynamic {{context.title}}' },
        },
      ],
    });
    await harness.createRule({
      id: UNKNOWN_RULE_ID,
      ruleTypeId: RULE_TYPE,
      params: ruleParams,
      actions: [{ ...serverLog, actionTypeId: '.does-not-exist', params: {} }],
    });
    await harness.es.index({
      index: SOURCE_INDEX,
      refresh: 'wait_for',
      document: { '@timestamp': new Date().toISOString(), message: 'hello' },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('declares what its process needs and what it is, from its module file', () => {
    expect(taskType.type).toBe('alerting:.es-query');
    expect(taskType.settings).toEqual(['alerting', 'actions', 'security', 'alertingRun']);
    expect(taskType.encryptedSavedObjectTypes?.map((t) => t.type).sort()).toEqual([
      'action',
      'action_task_params',
      'alert',
    ]);
  });

  it('runs the rule, writes the alert and the event log, and enqueues the action for Kibana', async () => {
    const { result } = await harness.run(RULE_ID, RULE_TYPE);
    expect(result).toEqual(
      expect.objectContaining({ schedule: { interval: '1m' }, state: expect.any(Object) })
    );

    expect((await harness.getAlertDocs(ALERTS_INDEX, RULE_ID)).length).toBeGreaterThan(0);

    const events = await harness.getEventDocs(RULE_ID, (docs) => docs.length >= 2);
    const actions = events.map((doc) => doc.event.action);
    expect(actions).toEqual(expect.arrayContaining(['execute-start', 'execute']));
    expect(events[0].kibana.server_uuid).toBe(KIBANA_UUID);

    const { tasks, actionTaskParams } = await harness.getEnqueued();
    expect(tasks.filter((task) => task.taskType === 'actions:.server-log')).toHaveLength(1);
    expect(actionTaskParams).toHaveLength(1);
  });

  it('serves a rule that uses the cases system action, which cases contributes to the process', async () => {
    const { onDispatchFailure } = await harness.run(CASES_RULE_ID, RULE_TYPE);
    expect(onDispatchFailure).not.toHaveBeenCalled();
  });

  it('enqueues the action of a connector that Kibana registered while it ran, as sent, not rebuilt from config', async () => {
    const { onDispatchFailure } = await harness.run(DYNAMIC_RULE_ID, RULE_TYPE);
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const { actionTaskParams } = await harness.getEnqueued();
    expect(
      actionTaskParams.filter((params) => params.actionId === DYNAMIC_CONNECTOR.id)
    ).toHaveLength(1);
  });

  it('declines every run, before anything is written, when Kibana registered a connector type the process lacks', async () => {
    harness.unregisteredConnectorTypes = ['.registered-after-the-bundle-was-built'];
    try {
      const onDispatchFailure = jest.fn();
      await expect(harness.run(RULE_ID, RULE_TYPE, { onDispatchFailure })).rejects.toThrow('422');
      expect(onDispatchFailure).toHaveBeenCalledTimes(1);
    } finally {
      harness.unregisteredConnectorTypes = [];
    }
  });

  it('declines a rule that uses an action type it does not know, without local execution', async () => {
    const onDispatchFailure = jest.fn();
    await expect(harness.run(UNKNOWN_RULE_ID, RULE_TYPE, { onDispatchFailure })).rejects.toThrow(
      '422'
    );
    expect(onDispatchFailure).toHaveBeenCalledTimes(1);
    expect(await harness.getAlertDocs(ALERTS_INDEX, UNKNOWN_RULE_ID)).toHaveLength(0);
  });
});

describe.each([
  { mode: 'child_process', reuse: false },
  { mode: 'child_process', reuse: true },
  { mode: 'remote', reuse: false },
  { mode: 'remote', reuse: true },
] as const)('native rule metrics in $mode (reuse: $reuse)', ({ mode, reuse }) => {
  let harness: RuleProcessHarness;
  let collector: Awaited<ReturnType<typeof createNativeMetricsCollector>>;
  beforeAll(async () => {
    collector = await createNativeMetricsCollector();
    harness = await startRuleProcessHarness({
      mode,
      reuse,
      instrumentation: createNativeMetricsInstrumentation(collector.url),
      rules: [{ taskType, bundle: 'stackAlerts__es_query' }],
    });
    await harness.createRule({
      id: 'native-metrics-rule',
      ruleTypeId: RULE_TYPE,
      params: ruleParams,
      actions: [],
    });
    await harness.es.index({
      index: SOURCE_INDEX,
      document: { '@timestamp': new Date().toISOString() },
      refresh: 'wait_for',
    });
  });
  afterAll(async () => {
    try {
      await harness?.stop();
    } finally {
      await collector?.stop();
    }
  });
  it('flushes each native rule counter exactly once with delta temporality and worker identity', async () => {
    for (const expected of [1, 2]) {
      const { result, onDispatchFailure } = await harness.run('native-metrics-rule', RULE_TYPE);
      expect(result).toEqual(
        expect.objectContaining({ state: expect.any(Object), schedule: { interval: '1m' } })
      );
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const samples = collector.samples.filter(
        ({ name }) => name === 'kibana.alerting.rule_run.count'
      );
      expect(samples.reduce((total, { value }) => total + value, 0)).toBe(expected);
      expect(samples.every(({ temporality }) => temporality === 1)).toBe(true);
      for (const sample of samples) {
        expect(sample.attributes).toEqual(
          expect.arrayContaining([
            { key: 'credential.type', value: { stringValue: 'es_api_key' } },
            { key: 'credential.reason', value: { stringValue: 'config' } },
          ])
        );
      }
      expect(collector.errors).toEqual([]);
    }
    const instances = new Set(
      collector.samples
        .filter(({ name, value }) => name === 'kibana.alerting.rule_run.count' && value > 0)
        .map(({ instanceId }) => instanceId)
    );
    expect(instances.size).toBe(reuse ? 1 : 2);
    expect(harness.supervisor.getStats().spawned).toBe(reuse ? 1 : 2);
  });
});

describe.each([
  { mode: 'child_process', reuse: false },
  { mode: 'child_process', reuse: true },
  { mode: 'remote', reuse: false },
  { mode: 'remote', reuse: true },
] as const)('native rule Prometheus in $mode (reuse: $reuse)', ({ mode, reuse }) => {
  let harness: RuleProcessHarness;
  let collector: Awaited<ReturnType<typeof createNativePrometheusCollector>>;
  let unregisterGauges: (() => void) | undefined;
  beforeAll(async () => {
    collector = await createNativePrometheusCollector();
    harness = await startRuleProcessHarness({
      mode,
      reuse,
      instrumentation: createNativePrometheusInstrumentation(),
      onMetrics: (metrics) => collector.exporter.addMetrics(metrics),
      rules: [{ taskType, bundle: 'stackAlerts__es_query' }],
    });
    unregisterGauges = collector.exporter.registerGaugeSource(() => harness.collectGaugeMetrics());
    await harness.createRule({
      id: 'native-metrics-rule',
      ruleTypeId: RULE_TYPE,
      params: ruleParams,
      actions: [],
    });
    await harness.es.index({
      index: SOURCE_INDEX,
      document: { '@timestamp': new Date().toISOString() },
      refresh: 'wait_for',
    });
  });
  afterAll(async () => {
    try {
      unregisterGauges?.();
      await harness?.stop();
    } finally {
      await collector?.stop();
    }
  });
  it('retains exact native rule counters at the Main scrape endpoint across worker reuse and retirement', async () => {
    for (const expected of [1, 2]) {
      const { result, onDispatchFailure } = await harness.run('native-metrics-rule', RULE_TYPE);
      expect(result).toEqual(
        expect.objectContaining({ state: expect.any(Object), schedule: { interval: '1m' } })
      );
      expect(onDispatchFailure).not.toHaveBeenCalled();
      const body = await collector.scrape();
      const counters = body
        .split('\n')
        .filter((line) => line.startsWith('kibana_alerting_rule_run_count_total{'));
      expect(
        counters.reduce((total, line) => total + Number(line.slice(line.lastIndexOf(' ') + 1)), 0)
      ).toBe(expected);
      expect(
        counters.every(
          (line) =>
            line.includes('credential_type="es_api_key"') &&
            line.includes('credential_reason="config"')
        )
      ).toBe(true);
    }
    expect(await harness.collectGaugeMetrics()).toHaveLength(reuse ? 1 : 0);
    expect(harness.supervisor.getStats().spawned).toBe(reuse ? 1 : 2);
  });
});
