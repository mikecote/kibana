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
import { ApmRuleType } from '@kbn/rule-data-utils';
import { getMlRuleTestSettings } from '@kbn/ml-plugin/server/integration_tests/fixtures/ml_rule_test_settings';
import { configSchema as apmSourcesAccessConfigSchema } from '@kbn/apm-sources-access-plugin/common/config_schema';
import { config as apmConfig } from '..';
import { taskType as errorCount } from '../task_types/error_count.task';
import { taskType as transactionDuration } from '../task_types/transaction_duration.task';
import { taskType as transactionErrorRate } from '../task_types/transaction_error_rate.task';
import { taskType as anomaly } from '../task_types/anomaly.task';

const ALERTS_INDEX = '.alerts-observability.apm.alerts-*';
const APM_INDEX = 'apm-test';
const ML_JOB_ID = 'apm-tx-metrics-production';

/**
 * The four APM rule types, each from its own bundle forked the way Kibana does, against
 * Elasticsearch with a few APM documents (the default `apm-*` indices) and, for the anomaly rule, an
 * anomaly detection job of the APM group with a record result. Each run is compared with the same
 * rule run in the test process, as Kibana's runtime does.
 */
describe('the APM rule types served from bundles', () => {
  let harness: RuleProcessHarness;

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      // The anomaly rule first: the module the harness seeds with has the saved object type of the ML jobs.
      rules: [
        { taskType: anomaly, bundle: 'apm__anomaly' },
        { taskType: errorCount, bundle: 'apm__error_count' },
        { taskType: transactionDuration, bundle: 'apm__transaction_duration' },
        { taskType: transactionErrorRate, bundle: 'apm__transaction_error_rate' },
      ],
      settings: {
        // What the APM plugin registers for its rule types in a process. Transactions are searched in
        // their own indices rather than the aggregated metrics, which a bare Elasticsearch has none of.
        apm: (apmConfig.schema as any).validate(
          { searchAggregatedTransactions: 'never' },
          { serverless: false }
        ),
        apmSourcesAccess: { indices: apmSourcesAccessConfigSchema.validate({}).indices },
        ml: await getMlRuleTestSettings(),
      },
      indices: {
        [APM_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            'event.ingested': { type: 'date' },
            'event.outcome': { type: 'keyword' },
            'processor.event': { type: 'keyword' },
            'service.name': { type: 'keyword' },
            'service.environment': { type: 'keyword' },
            'transaction.type': { type: 'keyword' },
            'transaction.name': { type: 'keyword' },
            'transaction.duration.us': { type: 'long' },
            'error.grouping_key': { type: 'keyword' },
          },
        },
      },
    });

    const timestamp = new Date().toISOString();
    const service = { 'service.name': 'checkout', 'service.environment': 'production' };
    const docs = [
      // Three errors of one service.
      ...[1, 2, 3].map((i) => ({
        ...service,
        '@timestamp': timestamp,
        'processor.event': 'error',
        'error.grouping_key': `group-${i}`,
      })),
      // Transactions: slow ones, a failure among them.
      ...[
        ['success', 5_000_000],
        ['success', 7_000_000],
        ['failure', 6_000_000],
      ].map(([outcome, duration]) => ({
        ...service,
        '@timestamp': timestamp,
        'processor.event': 'transaction',
        'transaction.type': 'request',
        'transaction.name': 'GET /cart',
        'transaction.duration.us': duration,
        'event.outcome': outcome,
      })),
    ];
    await harness.es.bulk({
      refresh: 'wait_for',
      operations: docs.flatMap((doc) => [{ create: { _index: APM_INDEX } }, doc]),
    });

    // The anomaly detection job of the APM group the anomaly rule reads, with a record result.
    await harness.es.ml.putJob({
      job_id: ML_JOB_ID,
      groups: ['apm'],
      analysis_config: {
        bucket_span: '15m',
        detectors: [{ function: 'high_mean', field_name: 'transaction.duration.us' }],
      },
      data_description: { time_field: '@timestamp' },
      custom_settings: { job_tags: { apm_ml_version: '3', environment: 'production' } },
    });
    await harness.es.ml.putDatafeed({
      datafeed_id: `datafeed-${ML_JOB_ID}`,
      job_id: ML_JOB_ID,
      indices: [APM_INDEX],
    });
    await harness.savedObjectsClient.create(
      'ml-job',
      { job_id: ML_JOB_ID, datafeed_id: `datafeed-${ML_JOB_ID}`, type: 'anomaly-detector' },
      { id: `anomaly-detector-${ML_JOB_ID}` }
    );
    await harness.es.index({
      index: '.ml-anomalies-shared',
      refresh: 'wait_for',
      document: {
        job_id: ML_JOB_ID,
        result_type: 'record',
        timestamp: Date.now() - 60 * 1000,
        bucket_span: 900,
        record_score: 95,
        initial_record_score: 95,
        probability: 0.0001,
        detector_index: 0,
        function: 'high_mean',
        partition_field_name: 'service.name',
        partition_field_value: 'checkout',
        by_field_name: 'transaction.type',
        by_field_value: 'request',
        is_interim: false,
        processing_time_ms: 1,
      },
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

  it('alerts when the errors reach the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'error-count',
        ruleTypeId: ApmRuleType.ErrorCount,
        consumer: 'apm',
        params: { windowSize: 5, windowUnit: 'm', threshold: 2, environment: 'ENVIRONMENT_ALL' },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('runs to a success without an alert when the errors stay below the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'error-count-quiet',
        ruleTypeId: ApmRuleType.ErrorCount,
        consumer: 'apm',
        params: { windowSize: 5, windowUnit: 'm', threshold: 50, environment: 'ENVIRONMENT_ALL' },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 0);
    expect(forked).toEqual(inProcess);
  });

  it('alerts when the transaction duration is over the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'transaction-duration',
        ruleTypeId: ApmRuleType.TransactionDuration,
        consumer: 'apm',
        params: {
          windowSize: 5,
          windowUnit: 'm',
          threshold: 1000,
          aggregationType: 'avg',
          environment: 'ENVIRONMENT_ALL',
        },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('alerts when the transaction error rate is over the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'transaction-error-rate',
        ruleTypeId: ApmRuleType.TransactionErrorRate,
        consumer: 'apm',
        params: { windowSize: 5, windowUnit: 'm', threshold: 10, environment: 'ENVIRONMENT_ALL' },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('alerts for an anomaly of the APM job above the severity, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'apm-anomaly',
        ruleTypeId: ApmRuleType.Anomaly,
        consumer: 'apm',
        params: {
          windowSize: 30,
          windowUnit: 'm',
          environment: 'ENVIRONMENT_ALL',
          anomalySeverityType: 'major',
        },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });
});
