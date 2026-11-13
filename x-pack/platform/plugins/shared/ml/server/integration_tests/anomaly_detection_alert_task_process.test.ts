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
import { ML_ALERT_TYPES } from '../../common/constants/alerts';
import { taskType } from '../task_types/anomaly_detection_alert.task';
import { getMlRuleTestSettings } from './fixtures/ml_rule_test_settings';

const RULE_TYPE = ML_ALERT_TYPES.ANOMALY_DETECTION;
const ALERTS_INDEX = '.alerts-*';
const JOB_ID = 'ad-job-1';

/**
 * The anomaly detection alerting rule type from its own bundle, forked the way Kibana does, against a
 * real Elasticsearch with an anomaly detection job and datafeed (never started) and a bucket result written for it,
 * so the rule has an anomaly to alert on without a machine learning node having to run the job.
 */
describe('the anomaly detection alert rule type served from a bundle', () => {
  let harness: RuleProcessHarness;

  const params = (severity: number) => ({
    jobSelection: { jobIds: [JOB_ID] },
    severity,
    resultType: 'bucket',
    includeInterim: false,
    lookbackInterval: null,
    topNBuckets: null,
    kqlQueryString: null,
  });

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'ml__anomaly_detection_alert' }],
      // What Kibana sends for the ML plugin.
      settings: { ml: await getMlRuleTestSettings() },
    });
    await harness.es.ml.putJob({
      job_id: JOB_ID,
      analysis_config: { bucket_span: '15m', detectors: [{ function: 'count' }] },
      data_description: { time_field: '@timestamp' },
    });
    await harness.es.indices.create({
      index: 'ml-source',
      mappings: { properties: { '@timestamp': { type: 'date' } } },
    });
    await harness.es.ml.putDatafeed({
      datafeed_id: `datafeed-${JOB_ID}`,
      job_id: JOB_ID,
      indices: ['ml-source'],
    });
    // The saved object that makes the job visible in the default space, as ML keeps it.
    await harness.savedObjectsClient.create(
      'ml-job',
      { job_id: JOB_ID, datafeed_id: `datafeed-${JOB_ID}`, type: 'anomaly-detector' },
      { id: `anomaly-detector-${JOB_ID}` }
    );
    await harness.es.index({
      index: '.ml-anomalies-shared',
      refresh: 'wait_for',
      document: {
        job_id: JOB_ID,
        result_type: 'bucket',
        timestamp: Date.now() - 60 * 1000,
        bucket_span: 900,
        anomaly_score: 90,
        initial_anomaly_score: 90,
        event_count: 100,
        is_interim: false,
        bucket_influencers: [],
        processing_time_ms: 1,
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts for an anomaly above the severity, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      { id: 'anomaly-found', ruleTypeId: RULE_TYPE, params: params(50) },
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(1);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });

  it('runs to a success without an alert when the anomaly is below the severity, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      { id: 'anomaly-quiet', ruleTypeId: RULE_TYPE, params: params(99) },
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(0);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });
});
