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
import { SYNTHETICS_STATUS_RULE, SYNTHETICS_TLS_RULE } from '@kbn/rule-data-utils';
import { config as observabilityConfig } from '@kbn/observability-plugin/server';
import { syntheticsMonitorSavedObjectType } from '../../common/types/saved_objects';
import { taskType as monitorStatus } from '../task_types/monitor_status.task';
import { taskType as tls } from '../task_types/tls.task';

const ALERTS_INDEX = '.alerts-observability.uptime.alerts-*';
const PINGS_INDEX = 'synthetics-http-default';
const CONFIG_ID = 'config-1';
const MONITOR_ID = 'monitor-1';
const LOCATION = { id: 'us_central', label: 'US Central', isServiceManaged: true };

/**
 * The two Synthetics rule types, each from its own bundle forked the way Kibana does, against a real
 * Elasticsearch with an HTTP monitor (the saved object Synthetics stores it as) and a down ping of
 * it that carries a certificate that expires soon. Each run is compared with the same rule run in the
 * test process, as Kibana's runtime does.
 */
describe('the Synthetics rule types served from bundles', () => {
  let harness: RuleProcessHarness;

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
      rules: [
        { taskType: monitorStatus, bundle: 'synthetics__monitor_status' },
        { taskType: tls, bundle: 'synthetics__tls' },
      ],
      settings: {
        // What the Synthetics plugin registers for its rule types in a process.
        synthetics: {
          service: {},
          isCpsEnabled: false,
          serviceManagedLocations: {
            isAllowed: true,
            locations: [LOCATION],
            throttling: undefined,
          },
        },
        observability: (observabilityConfig.schema as any).validate({}),
      },
    });

    await harness.savedObjectsClient.create(
      syntheticsMonitorSavedObjectType,
      {
        id: MONITOR_ID,
        config_id: CONFIG_ID,
        name: 'Checkout',
        type: 'http',
        enabled: true,
        schedule: { number: '1', unit: 'm' },
        locations: [LOCATION],
        urls: 'https://checkout.test',
        tags: [],
        alert: { status: { enabled: true }, tls: { enabled: true } },
        origin: 'ui',
      },
      { id: CONFIG_ID }
    );

    const now = Date.now();
    // The data stream template of the Synthetics integration, which Fleet installs in Kibana (it takes over from
    // Elasticsearch's own `synthetics` template, which leaves the time a check covers and the dates of the
    // certificate to dynamic mapping).
    await harness.es.indices.putIndexTemplate({
      name: 'synthetics-test-mappings',
      index_patterns: ['synthetics-*'],
      data_stream: {},
      priority: 500,
      template: {
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            config_id: { type: 'keyword' },
            monitor: {
              properties: {
                id: { type: 'keyword' },
                name: { type: 'keyword' },
                type: { type: 'keyword' },
                status: { type: 'keyword' },
                duration: { properties: { us: { type: 'long' } } },
                timespan: { type: 'date_range' },
              },
            },
            observer: {
              properties: {
                name: { type: 'keyword' },
                geo: { properties: { name: { type: 'keyword' } } },
              },
            },
            summary: {
              properties: {
                up: { type: 'long' },
                down: { type: 'long' },
                final_attempt: { type: 'boolean' },
                status: { type: 'keyword' },
              },
            },
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
    await harness.es.index({
      index: PINGS_INDEX,
      op_type: 'create',
      refresh: 'wait_for',
      document: {
        '@timestamp': new Date(now - 30_000).toISOString(),
        config_id: CONFIG_ID,
        monitor: {
          id: MONITOR_ID,
          name: 'Checkout',
          type: 'http',
          status: 'down',
          duration: { us: 1000 },
          // The time the check covers, which the certificate search reads.
          timespan: {
            gte: new Date(now - 60_000).toISOString(),
            lt: new Date(now + 60_000).toISOString(),
          },
        },
        observer: { name: LOCATION.id, geo: { name: LOCATION.label } },
        summary: { up: 0, down: 1, final_attempt: true, status: 'down' },
        url: { full: 'https://checkout.test' },
        tls: {
          server: {
            hash: { sha1: 'sha1-1', sha256: 'sha256-1' },
            x509: {
              not_after: new Date(now + 10 * 24 * 3600 * 1000).toISOString(),
              not_before: new Date(now - 100 * 24 * 3600 * 1000).toISOString(),
              issuer: { common_name: 'Test CA' },
              subject: { common_name: 'checkout.test' },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts for a down monitor, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'synthetics-down',
        ruleTypeId: SYNTHETICS_STATUS_RULE,
        consumer: 'uptime',
        params: {
          condition: {
            window: { numberOfChecks: 1 },
            downThreshold: 1,
            locationsThreshold: 1,
            groupBy: 'locationId',
          },
        },
      },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    expect(forked).toEqual(inProcess);
  });

  it('alerts for a certificate that expires soon, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      { id: 'synthetics-tls', ruleTypeId: SYNTHETICS_TLS_RULE, consumer: 'uptime', params: {} },
      ALERTS_INDEX
    );
    expectServed(forked, 1);
    // The date of the summary carries the time zone abbreviation only where moment has a default zone
    // (the test process), not in a Kibana server or its task process.
    const withoutZone = (value: unknown) =>
      JSON.parse(
        JSON.stringify(value)
          .replace(/ (EST|EDT|UTC|GMT)(?= in)/g, '')
          .replace(/ {2,}/g, ' ')
      );
    expect(withoutZone(forked)).toEqual(withoutZone(inProcess));
  });
});
