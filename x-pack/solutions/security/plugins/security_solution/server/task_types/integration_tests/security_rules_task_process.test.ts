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

import { config as ruleRegistryConfig } from '@kbn/rule-registry-plugin/server';
import { ConfigSchema as listsConfigSchema } from '@kbn/lists-plugin/server/config';
import { config as fleetConfig } from '@kbn/fleet-plugin/server/config';
import { appContextService } from '@kbn/fleet-plugin/server/services';
import { parseExperimentalConfigValue } from '@kbn/fleet-plugin/common/experimental_features';
import {
  getFleetPackageMetadataTaskProcessSettings,
  stopFleetRunAppContext,
} from '@kbn/fleet-plugin/server/services/run_time';
import type { FleetPackageMetadataTaskProcessSettings } from '@kbn/fleet-plugin/server/package_metadata_task_process_settings';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { startRuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import {
  EQL_RULE_TYPE_ID,
  ESQL_RULE_TYPE_ID,
  INDICATOR_RULE_TYPE_ID,
  ML_RULE_TYPE_ID,
  NEW_TERMS_RULE_TYPE_ID,
  QUERY_RULE_TYPE_ID,
  SAVED_QUERY_RULE_TYPE_ID,
  THRESHOLD_RULE_TYPE_ID,
} from '@kbn/securitysolution-rules';
import { LEGACY_NOTIFICATIONS_ID } from '../../../common/constants';
import { createMockConfig } from '../../config.mock';
import { getTaskProcessSettings } from '../../config';
import { taskType as eql } from '../eql.task';
import { taskType as esql } from '../esql.task';
import { taskType as indicatorMatch } from '../indicator_match.task';
import { taskType as ml } from '../ml.task';
import { taskType as newTerms } from '../new_terms.task';
import { taskType as notifications } from '../notifications.task';
import { taskType as query } from '../query.task';
import { taskType as savedQuery } from '../saved_query.task';
import { taskType as threshold } from '../threshold.task';

const ALERTS_INDEX = '.alerts-security.alerts-default';
const SOURCE_INDEX = 'security-source';
const THREAT_INDEX = 'security-threats';
const ML_JOB_ID = 'security-job-1';
const EXCEPTION_LIST_ID = 'rule-exceptions';
const ENDPOINT_SOURCE_INDEX = 'security-endpoint-source';
const AGENT_ID = 'endpoint-agent-1';
const AGENT_POLICY_ID = 'agent-policy-1';
const PACKAGE_POLICY_ID = 'endpoint-package-policy-1';

/** What the detection rule types have in common, as the rule stores them. */
const baseParams = {
  author: [],
  description: 'A rule of the real run tests',
  falsePositives: [],
  from: 'now-1h',
  immutable: false,
  ruleSource: { type: 'internal' },
  license: '',
  outputIndex: '',
  maxSignals: 100,
  riskScore: 21,
  riskScoreMapping: [],
  severity: 'low',
  severityMapping: [],
  threat: [],
  to: 'now',
  references: [],
  version: 1,
  exceptionsList: [],
  relatedIntegrations: [],
  requiredFields: [],
  setup: '',
};

const securityRule = (
  id: string,
  ruleTypeId: string,
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) => ({
  id,
  ruleTypeId,
  consumer: 'siem',
  params: { ...baseParams, ruleId: `${id}-uuid`, ...params },
  ...extra,
});

/**
 * The detection rule types from their own bundles, forked the way Kibana does, against a real
 * Elasticsearch with a source index, an indicator index, a saved query, an exception list and an ML
 * job: each run is served by the process (never declined), the rule writes its alerts with the rule
 * data client and the rule execution events to the event log, and a run equals the same rule run in
 * the test process, as Kibana's runtime does it.
 */
describe('the detection rule types served from bundles', () => {
  let harness: RuleProcessHarness;

  const expectServed = (
    forked: Awaited<ReturnType<RuleProcessHarness['runBoth']>>['forked'],
    alerts: number
  ) => {
    // The rule's own execution outcome is in the events of the rule monitoring (below), the framework's
    // `execute` event only says the executor ran.
    expect(forked.events.find((event: { action: string }) => event.action === 'execute')).toEqual(
      expect.objectContaining({ outcome: 'success' })
    );
    expect(forked.alerts).toHaveLength(alerts);
  };

  const run = async (
    seed: ReturnType<typeof securityRule>,
    alerts: number,
    expectedEvents = 4,
    references?: Array<{ id: string; name: string; type: string }>
  ) => {
    const { forked, inProcess } = await harness.runBoth(
      references ? { ...seed, references } : seed,
      ALERTS_INDEX,
      expectedEvents
    );
    expectServed(forked, alerts);
    expect(forked).toEqual(inProcess);
    return forked;
  };

  beforeAll(async () => {
    const settings = {
      securitySolution: getTaskProcessSettings(createMockConfig()),
      ruleRegistry: ruleRegistryConfig.schema.validate({}),
      lists: listsConfigSchema.validate({}),
      fleet: fleetConfig.schema.validate({}),
      ml: { cpsEnabled: false },
      fleetPackageMetadata: undefined as FleetPackageMetadataTaskProcessSettings | undefined,
    };
    harness = await startRuleProcessHarness({
      // The ML rule first: the module the harness seeds with has the saved object types of the ML jobs.
      rules: [
        { taskType: ml, bundle: 'securitySolution__ml' },
        { taskType: query, bundle: 'securitySolution__query' },
        { taskType: savedQuery, bundle: 'securitySolution__saved_query' },
        { taskType: eql, bundle: 'securitySolution__eql' },
        { taskType: esql, bundle: 'securitySolution__esql' },
        { taskType: threshold, bundle: 'securitySolution__threshold' },
        { taskType: newTerms, bundle: 'securitySolution__new_terms' },
        { taskType: indicatorMatch, bundle: 'securitySolution__indicator_match' },
        { taskType: notifications, bundle: 'securitySolution__notifications' },
      ],
      settings,
      indices: {
        [SOURCE_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            message: { type: 'keyword' },
            'event.category': { type: 'keyword' },
            'host.name': { type: 'keyword' },
            'user.name': { type: 'keyword' },
          },
        },
        [ENDPOINT_SOURCE_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            message: { type: 'keyword' },
            'host.name': { type: 'keyword' },
            agent: {
              properties: {
                id: { type: 'keyword' },
                name: { type: 'keyword' },
                type: { type: 'keyword' },
              },
            },
          },
        },
        [THREAT_INDEX]: {
          properties: {
            '@timestamp': { type: 'date' },
            'host.name': { type: 'keyword' },
          },
        },
      },
    });

    const now = new Date().toISOString();
    await harness.es.bulk({
      refresh: 'wait_for',
      operations: [
        ['host-a', 'alice'],
        ['host-a', 'bob'],
        ['host-b', 'carol'],
      ].flatMap(([host, user]) => [
        { create: { _index: SOURCE_INDEX } },
        {
          '@timestamp': now,
          message: 'hello',
          'event.category': 'process',
          'host.name': host,
          'user.name': user,
        },
      ]),
    });
    // One indicator: host-b is a known bad host.
    await harness.es.index({
      index: THREAT_INDEX,
      refresh: 'wait_for',
      document: { '@timestamp': now, 'host.name': 'host-b' },
    });

    // A saved query that matches one host.
    await harness.savedObjectsClient.create(
      'query',
      {
        title: 'Host A',
        titleKeyword: 'Host A',
        description: '',
        query: { query: 'host.name: host-a', language: 'kuery' },
        filters: [],
      },
      { id: 'saved-query-1' }
    );

    // An exception list of the lists plugin, with an item that excludes host-b.
    const timestamps = { created_at: now, created_by: 'elastic', updated_by: 'elastic' };
    await harness.savedObjectsClient.create(
      'exception-list',
      {
        ...timestamps,
        _tags: [],
        comments: [],
        description: 'Exceptions of the rule',
        entries: [],
        immutable: false,
        list_id: EXCEPTION_LIST_ID,
        list_type: 'list',
        meta: undefined,
        name: 'Rule exceptions',
        os_types: [],
        tags: [],
        tie_breaker_id: 'tie-1',
        type: 'detection',
        version: 1,
      } as never,
      { id: 'exception-list-1' }
    );
    await harness.savedObjectsClient.create(
      'exception-list',
      {
        ...timestamps,
        _tags: [],
        comments: [],
        description: 'Not host-b',
        entries: [{ field: 'host.name', operator: 'included', type: 'match', value: 'host-b' }],
        item_id: 'exception-item-1',
        list_id: EXCEPTION_LIST_ID,
        list_type: 'item',
        meta: undefined,
        name: 'Host b',
        os_types: [],
        tags: [],
        tie_breaker_id: 'tie-2',
        type: 'simple',
      } as never,
      { id: 'exception-item-1' }
    );

    // What Fleet and the Endpoint metadata hold for an enrolled Elastic Defend host, and the data streams of the
    // Elastic Defend package (which Kibana installs): what the isolate response action of a rule reads and writes.
    const { host } = harness.seeder;
    const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
    if (!security) throw new Error('The rule fixture requires native task Security');
    appContextService.startExecution({
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      securitySetup: { audit: security.audit, license: security.license },
      registry: { kind: 'native' },
      configInitialValue: settings.fleet,
      experimentalFeatures: parseExperimentalConfigValue([], {}),
      logger: host.logger.get('fleet-fixture'),
      kibanaVersion: harness.kibanaVersion,
      kibanaBranch: 'main',
      kibanaInstanceId: host.server.uuid,
      isProductionMode: false,
      isFipsEnabled: host.security.fips.isEnabled(),
    });
    settings.fleetPackageMetadata = await getFleetPackageMetadataTaskProcessSettings();
    const fleetClient = harness.seeder.host.savedObjects.getUnsafeInternalClient({
      includedHiddenTypes: ['ingest-agent-policies', 'ingest-package-policies'],
    });
    await fleetClient.create(
      'ingest-agent-policies',
      {
        name: 'policy',
        namespace: 'default',
        status: 'active',
        is_managed: false,
        revision: 1,
        updated_at: now,
        updated_by: 'elastic',
      },
      { id: AGENT_POLICY_ID }
    );
    await fleetClient.create(
      'ingest-package-policies',
      {
        name: 'endpoint-1',
        namespace: 'default',
        enabled: true,
        policy_id: AGENT_POLICY_ID,
        policy_ids: [AGENT_POLICY_ID],
        package: { name: 'endpoint', title: 'Elastic Defend', version: '9.0.0' },
        inputs: [],
        revision: 1,
        created_at: now,
        created_by: 'elastic',
        updated_at: now,
        updated_by: 'elastic',
      },
      { id: PACKAGE_POLICY_ID }
    );
    await harness.es.index({
      index: '.fleet-agents',
      id: AGENT_ID,
      refresh: 'wait_for',
      document: {
        active: true,
        policy_id: AGENT_POLICY_ID,
        type: 'PERMANENT',
        enrolled_at: now,
        agent: { id: AGENT_ID, version: '9.0.0' },
        local_metadata: { host: { hostname: 'host-1' }, elastic: { agent: { version: '9.0.0' } } },
      },
    });
    await harness.es.indices.putIndexTemplate({
      name: 'test-endpoint-actions',
      index_patterns: ['.logs-endpoint.actions-*'],
      data_stream: { hidden: true },
      priority: 200,
      template: {
        mappings: {
          properties: {
            '@timestamp': { type: 'date' },
            originSpaceId: { type: 'keyword' },
            tags: { type: 'keyword' },
            agent: {
              properties: {
                id: { type: 'keyword' },
                policy: {
                  properties: {
                    agentId: { type: 'keyword' },
                    elasticAgentId: { type: 'keyword' },
                    integrationPolicyId: { type: 'keyword' },
                    agentPolicyId: { type: 'keyword' },
                  },
                },
              },
            },
          },
        },
      },
    });
    await harness.es.indices.putIndexTemplate({
      name: 'test-endpoint-action-responses',
      index_patterns: ['.logs-endpoint.action.responses-*'],
      data_stream: { hidden: true },
      priority: 200,
      template: { mappings: { properties: { '@timestamp': { type: 'date' } } } },
    });
    await harness.es.indices.create({
      index: 'metrics-endpoint.metadata_current_default',
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          event: { properties: { created: { type: 'date' } } },
          agent: { properties: { id: { type: 'keyword' }, version: { type: 'keyword' } } },
          elastic: { properties: { agent: { properties: { id: { type: 'keyword' } } } } },
          HostDetails: { properties: { agent: { properties: { id: { type: 'keyword' } } } } },
          host: { properties: { hostname: { type: 'keyword' }, name: { type: 'keyword' } } },
        },
      },
    });
    await harness.es.index({
      index: 'metrics-endpoint.metadata_current_default',
      refresh: 'wait_for',
      document: {
        '@timestamp': now,
        event: { created: now },
        agent: { id: AGENT_ID, version: '9.0.0' },
        elastic: { agent: { id: AGENT_ID } },
        host: { hostname: 'host-1', name: 'host-1' },
        Endpoint: { capabilities: [], status: 'enrolled' },
      },
    });
    await harness.es.index({
      index: ENDPOINT_SOURCE_INDEX,
      refresh: 'wait_for',
      document: {
        '@timestamp': now,
        message: 'detected',
        'host.name': 'host-1',
        agent: { id: AGENT_ID, name: 'host-1', type: 'endpoint' },
      },
    });

    // An anomaly detection job, never started: a bare Elasticsearch has no machine learning node.
    await harness.es.ml.putJob({
      job_id: ML_JOB_ID,
      analysis_config: { bucket_span: '15m', detectors: [{ function: 'count' }] },
      data_description: { time_field: '@timestamp' },
    });
    await harness.es.ml.putDatafeed({
      datafeed_id: `datafeed-${ML_JOB_ID}`,
      job_id: ML_JOB_ID,
      indices: [SOURCE_INDEX],
    });
    await harness.savedObjectsClient.create(
      'ml-job',
      { job_id: ML_JOB_ID, datafeed_id: `datafeed-${ML_JOB_ID}`, type: 'anomaly-detector' },
      { id: `anomaly-detector-${ML_JOB_ID}` }
    );
  });

  afterAll(async () => {
    stopFleetRunAppContext();
    await harness?.stop();
  });

  const queryParams = {
    type: 'query',
    language: 'kuery',
    query: '*:*',
    index: [SOURCE_INDEX],
    filters: [],
  };

  it('runs a query rule, writes the alerts and the rule execution events', async () => {
    const forked = await run(securityRule('sec-query', QUERY_RULE_TYPE_ID, queryParams), 3);
    expect(forked.events.map((event: { provider: string }) => event.provider)).toContain(
      'securitySolution.ruleExecution'
    );
    expect(forked.events.map((event: { action: string }) => event.action)).toEqual(
      expect.arrayContaining(['status-change', 'execution-metrics'])
    );
  });

  it('excludes the alerts of an exception list, as Kibana does', async () => {
    await run(
      securityRule('sec-exceptions', QUERY_RULE_TYPE_ID, {
        ...queryParams,
        exceptionsList: [
          {
            id: 'exception-list-1',
            list_id: EXCEPTION_LIST_ID,
            type: 'detection',
            namespace_type: 'single',
          },
        ],
      }),
      2,
      4,
      // Where Kibana stores the exception lists of a rule.
      [{ id: 'exception-list-1', name: 'param:exceptionsList_0', type: 'exception-list' }]
    );
  });

  it('runs a saved query rule with the query of its saved object', async () => {
    await run(
      securityRule('sec-saved-query', SAVED_QUERY_RULE_TYPE_ID, {
        type: 'saved_query',
        savedId: 'saved-query-1',
        language: 'kuery',
        index: [SOURCE_INDEX],
        filters: [],
      }),
      2
    );
  });

  it('runs an EQL rule', async () => {
    await run(
      securityRule('sec-eql', EQL_RULE_TYPE_ID, {
        type: 'eql',
        language: 'eql',
        query: 'process where host.name == "host-a"',
        index: [SOURCE_INDEX],
        filters: [],
      }),
      2
    );
  });

  it('runs an ES|QL rule', async () => {
    await run(
      securityRule('sec-esql', ESQL_RULE_TYPE_ID, {
        type: 'esql',
        language: 'esql',
        query: `FROM ${SOURCE_INDEX} METADATA _id, _version, _index | WHERE host.name == "host-b"`,
      }),
      1
    );
  });

  it('runs a threshold rule', async () => {
    await run(
      securityRule('sec-threshold', THRESHOLD_RULE_TYPE_ID, {
        ...queryParams,
        type: 'threshold',
        threshold: { field: ['host.name'], value: 2, cardinality: [] },
      }),
      1
    );
  });

  it('runs a new terms rule', async () => {
    await run(
      securityRule('sec-new-terms', NEW_TERMS_RULE_TYPE_ID, {
        ...queryParams,
        type: 'new_terms',
        newTermsFields: ['host.name'],
        historyWindowStart: 'now-7d',
      }),
      2
    );
  });

  it('runs an indicator match rule', async () => {
    await run(
      securityRule('sec-indicator', INDICATOR_RULE_TYPE_ID, {
        ...queryParams,
        type: 'threat_match',
        threatIndex: [THREAT_INDEX],
        threatQuery: '*:*',
        threatLanguage: 'kuery',
        threatMapping: [{ entries: [{ field: 'host.name', type: 'mapping', value: 'host.name' }] }],
        threatIndicatorPath: 'threat.indicator',
        concurrentSearches: 1,
        itemsPerSearch: 9000,
      }),
      1
    );
  });

  it('runs a machine learning rule whose job is not started, without an alert, as Kibana does', async () => {
    // A bare Elasticsearch has no machine learning node to run the job: the rule finds no anomaly to alert
    // on. The run in the test process ends the same way.
    await run(
      securityRule('sec-ml', ML_RULE_TYPE_ID, {
        type: 'machine_learning',
        anomalyThreshold: 50,
        machineLearningJobId: [ML_JOB_ID],
      }),
      0
    );
  });

  it('runs the legacy notifications rule of a detection rule, as Kibana does', async () => {
    await harness.createRule(securityRule('sec-legacy-target', QUERY_RULE_TYPE_ID, queryParams));
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'sec-legacy-notification',
        ruleTypeId: LEGACY_NOTIFICATIONS_ID,
        consumer: 'alerts',
        params: { ruleAlertId: 'sec-legacy-target' },
      },
      ALERTS_INDEX,
      2
    );
    expectServed(forked, 0);
    expect(forked).toEqual(inProcess);
  });

  it('schedules the response action of a rule through Fleet and the endpoint index, in the process', async () => {
    await harness.createRule(
      securityRule('sec-response-action', QUERY_RULE_TYPE_ID, {
        ...queryParams,
        index: [ENDPOINT_SOURCE_INDEX],
        responseActions: [
          { actionTypeId: '.endpoint', params: { command: 'isolate', comment: 'from a rule' } },
        ],
      })
    );
    await harness.run('sec-response-action', QUERY_RULE_TYPE_ID);

    expect(await harness.getAlertDocs(ALERTS_INDEX, 'sec-response-action')).toHaveLength(1);
    await harness.es.indices.refresh({
      index: ['.fleet-actions*', '.logs-endpoint.actions-default'],
    });
    const fleetActions = await harness.es.search({
      index: '.fleet-actions*',
      query: { term: { input_type: 'endpoint' } },
    });
    expect(fleetActions.hits.hits).toHaveLength(1);
    expect(fleetActions.hits.hits[0]._source).toEqual(
      expect.objectContaining({
        agents: [AGENT_ID],
        type: 'INPUT_ACTION',
        data: expect.objectContaining({ command: 'isolate' }),
        signed: expect.objectContaining({
          data: expect.any(String),
          signature: expect.any(String),
        }),
      })
    );
    const requests = await harness.es.search({
      index: '.logs-endpoint.actions-default',
      query: { match_all: {} },
    });
    expect(requests.hits.hits).toHaveLength(1);
    expect(requests.hits.hits[0]._source).toEqual(
      expect.objectContaining({
        agent: expect.objectContaining({ id: [AGENT_ID] }),
        rule: expect.objectContaining({ id: 'sec-response-action' }),
        EndpointActions: expect.objectContaining({
          data: expect.objectContaining({ command: 'isolate', comment: 'from a rule' }),
        }),
      })
    );
  });
});
