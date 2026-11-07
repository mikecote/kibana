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
import { getMlRuleTestSettings } from '@kbn/ml-plugin/server/integration_tests/fixtures/ml_rule_test_settings';
import { CLIENT_ALERT_TYPES } from '../../common/constants/uptime_alerts';
import { getMLJobId } from '../../common/lib';
import { taskType as durationAnomaly } from '../task_types/duration_anomaly.task';
import { taskType as monitorStatus } from '../task_types/monitor_status.task';
import { taskType as tlsCertificate } from '../task_types/tls_certificate.task';
import { taskType as tlsLegacy } from '../task_types/tls_legacy.task';

const ALERTS_INDEX = '.alerts-observability.uptime.alerts-*';
// Matches the default heartbeat indices of the uptime settings (`heartbeat-*`).
const HEARTBEAT_INDEX = 'heartbeat-8-test';
const MONITOR_ID = 'mon-1';
const ML_JOB_ID = getMLJobId(MONITOR_ID);

/**
 * The four uptime rule types, each from its own bundle forked the way Kibana does, against a real
 * Elasticsearch with a down summary and a certificate that expires soon in the heartbeat index and, for the
 * duration anomaly rule, an anomaly detection job with a record result. Each run is compared with
 * the same rule run in the test process, as Kibana's runtime does.
 */
describe('the uptime rule types served from bundles', () => {
  let harness: RuleProcessHarness;

  // The certificate summary formats a date with the abbreviation of the time zone (`z`), which moment
  // only knows when a default zone is set: the test process has one, a Kibana server (and so its
  // task process) has none. Neither is what the rule decides, so the abbreviation is left out.
  const withoutZone = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value)
        .replace(/ (EST|EDT|UTC|GMT)(?= in)/g, '')
        .replace(/ {2,}/g, ' ')
    );

  const expectServed = (
    forked: Awaited<ReturnType<RuleProcessHarness['runBoth']>>['forked'],
    alerts: number
  ) => {
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked.alerts).toHaveLength(alerts);
  };

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      // The duration anomaly rule first: the module the harness seeds with has the saved object type of the ML jobs.
      rules: [
        { taskType: durationAnomaly, bundle: 'uptime__duration_anomaly' },
        { taskType: monitorStatus, bundle: 'uptime__monitor_status' },
        { taskType: tlsCertificate, bundle: 'uptime__tls_certificate' },
        { taskType: tlsLegacy, bundle: 'uptime__tls_legacy' },
      ],
      settings: { ml: await getMlRuleTestSettings() },
      indices: {
        [HEARTBEAT_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            monitor: {
              properties: {
                id: { type: 'keyword' },
                name: { type: 'keyword' },
                type: { type: 'keyword' },
                status: { type: 'keyword' },
                timespan: { type: 'date_range' },
              },
            },
            observer: { properties: { geo: { properties: { name: { type: 'keyword' } } } } },
            summary: { properties: { up: { type: 'long' }, down: { type: 'long' } } },
            url: { properties: { full: { type: 'keyword' } } },
            tls: {
              properties: {
                server: {
                  properties: {
                    hash: {
                      properties: { sha1: { type: 'keyword' }, sha256: { type: 'keyword' } },
                    },
                    x509: {
                      properties: {
                        not_after: { type: 'date' },
                        not_before: { type: 'date' },
                        issuer: { properties: { common_name: { type: 'keyword' } } },
                        subject: { properties: { common_name: { type: 'keyword' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const now = Date.now();
    await harness.es.index({
      index: HEARTBEAT_INDEX,
      refresh: 'wait_for',
      document: {
        '@timestamp': new Date(now).toISOString(),
        monitor: {
          id: MONITOR_ID,
          name: 'Checkout',
          type: 'http',
          status: 'down',
          timespan: {
            gte: new Date(now - 60_000).toISOString(),
            lt: new Date(now + 60_000).toISOString(),
          },
        },
        observer: { geo: { name: 'Berlin' } },
        summary: { up: 0, down: 1 },
        url: { full: 'https://checkout.test' },
        tls: {
          server: {
            hash: { sha1: 'sha1-1', sha256: 'sha256-1' },
            x509: {
              // Expires in ten days: inside the 30 days of the default threshold.
              not_after: new Date(now + 10 * 24 * 3600 * 1000).toISOString(),
              not_before: new Date(now - 100 * 24 * 3600 * 1000).toISOString(),
              issuer: { common_name: 'Test CA' },
              subject: { common_name: 'checkout.test' },
            },
          },
        },
      },
    });

    // The anomaly detection job of the monitor, with a record result.
    await harness.es.ml.putJob({
      job_id: ML_JOB_ID,
      analysis_config: {
        bucket_span: '15m',
        detectors: [
          {
            function: 'high_mean',
            field_name: 'monitor.duration.us',
            by_field_name: 'observer.geo.name',
          },
        ],
        influencers: ['monitor.id', 'observer.geo.name'],
      },
      data_description: { time_field: '@timestamp' },
    });
    await harness.es.ml.putDatafeed({
      datafeed_id: `datafeed-${ML_JOB_ID}`,
      job_id: ML_JOB_ID,
      indices: [HEARTBEAT_INDEX],
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
        timestamp: now - 5 * 60 * 1000,
        bucket_span: 900,
        record_score: 95,
        initial_record_score: 95,
        probability: 0.00001,
        detector_index: 0,
        function: 'high_mean',
        function_description: 'mean',
        field_name: 'monitor.duration.us',
        by_field_name: 'observer.geo.name',
        by_field_value: 'Berlin',
        typical: [100000],
        actual: [5000000],
        influencers: [
          { influencer_field_name: 'monitor.id', influencer_field_values: [MONITOR_ID] },
        ],
        is_interim: false,
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts for a down monitor, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'uptime-down',
        ruleTypeId: CLIENT_ALERT_TYPES.MONITOR_STATUS,
        consumer: 'uptime',
        params: {
          numTimes: 1,
          timerangeCount: 1,
          timerangeUnit: 'h',
          shouldCheckStatus: true,
          shouldCheckAvailability: false,
          isAutoGenerated: true,
        },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('alerts for a certificate that expires soon, with the TLS rule and its legacy version, as Kibana does', async () => {
    for (const [id, ruleTypeId, alertsIndex] of [
      ['uptime-tls', CLIENT_ALERT_TYPES.TLS, ALERTS_INDEX],
      // The legacy rule type writes to the default alerts index.
      ['uptime-tls-legacy', CLIENT_ALERT_TYPES.TLS_LEGACY, '.alerts-default.alerts-*'],
    ]) {
      const { forked, inProcess } = await harness.runBoth(
        { id, ruleTypeId, consumer: 'uptime', params: {} },
        alertsIndex
      );
      expectServed(forked, 1);
      expect(withoutZone(forked)).toEqual(withoutZone(inProcess));
    }
  });

  it('alerts for an anomaly of the duration of a monitor, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'uptime-anomaly',
        ruleTypeId: CLIENT_ALERT_TYPES.DURATION_ANOMALY,
        consumer: 'uptime',
        params: { monitorId: MONITOR_ID, severity: 50 },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });
});
