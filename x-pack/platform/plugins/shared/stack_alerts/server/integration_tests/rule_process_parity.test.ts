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

import type { RuleRunContribution } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import {
  startRuleProcessHarness,
  stripVolatile,
  summarizeEvent,
} from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { taskType } from '../task_types/es_query.task';

const RULE_TYPE = '.es-query';
const ALERTS_INDEX = '.alerts-stack.alerts-default';
const SOURCE_INDEX = 'parity-source';
const SLOW_INDEX = 'parity-slow-source';
const CONNECTOR_ID = 'parity-server-log';

const ruleParams = (index: string, esQuery = '{"query":{"match_all":{}}}') => ({
  index: [index],
  timeField: '@timestamp',
  esQuery,
  size: 100,
  timeWindowSize: 1,
  timeWindowUnit: 'h',
  threshold: [0],
  thresholdComparator: '>',
  searchType: 'esQuery',
  excludeHitsFromPreviousRun: false,
  aggType: 'count',
  groupBy: 'all',
});

const slowQuery = JSON.stringify({
  query: {
    script: {
      script: {
        // Walks every document of the slow index for a while: Elasticsearch is busy when the run is cancelled.
        source: 'int x = 0; for (int i = 0; i < 900000; i++) { x += i % 7; } return x >= 0;',
      },
    },
  },
});

const serverLogAction = {
  group: 'query matched',
  actionTypeId: '.server-log',
  connectorId: CONNECTOR_ID,
  params: { level: 'info', message: 'matched {{context.title}}' },
};

// Stands in for the workflows plugin, which this branch gives no contribution: it records what a
// rule run sends. A forked process has the contributions its bundle was built with, so this is for
// the runs in the test process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const emittedEvents: Array<{ triggerId: string; payload: any }> = [];
const fakeWorkflows: RuleRunContribution = {
  register: ({ alerting }) => alerting.enableAlertStatusChanged({ isEnabled: async () => true }),
  getWorkflowsClient: async () =>
    ({
      isWorkflowsAvailable: true,
      emitEvent: async (triggerId: string, payload: unknown) => {
        emittedEvents.push({ triggerId, payload });
      },
    } as never),
};

describe('a rule run in a task process behaves as in Kibana', () => {
  let harness: RuleProcessHarness;
  let executor: { username: string; password: string };
  let outsider: { username: string; password: string };

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'stackAlerts__es_query' }],
      inProcessContributions: [fakeWorkflows],
    });
    await harness.createConnector(CONNECTOR_ID);
    await harness.es.index({
      index: SOURCE_INDEX,
      refresh: 'wait_for',
      document: { '@timestamp': new Date().toISOString(), message: 'hello' },
    });
    // Kibana registers its privileges in Elasticsearch when it starts, which a process does not.
    const privileges = {
      // Kibana's privilege checks always require the login action.
      login: ['login:'],
      execute_connectors: [
        'saved_object:action/get',
        'saved_object:action_task_params/create',
        'saved_object:action_task_params/bulk_create',
      ],
      read_data_views: ['saved_object:index-pattern/get', 'saved_object:index-pattern/bulk_get'],
      read_config: ['saved_object:config/get'],
    };
    executor = await harness.createUserWithPrivileges('executor', privileges, [
      'login',
      'execute_connectors',
      'read_data_views',
    ]);
    outsider = await harness.createUserWithPrivileges('outsider', privileges, [
      'login',
      'read_config',
    ]);
  });

  afterAll(async () => {
    await harness?.stop();
  });

  const actionTaskParamsOf = async (executionIdPrefix: string) =>
    (await harness.getEnqueued()).actionTaskParams.filter((params) =>
      String(params.executionId).startsWith(executionIdPrefix)
    );

  describe('enqueue authorization', () => {
    beforeAll(async () => {
      for (const [id, user] of [
        ['authorized', executor],
        ['unauthorized', outsider],
      ] as const) {
        await harness.createRule({
          id,
          name: 'authorization rule',
          ruleTypeId: RULE_TYPE,
          params: ruleParams(SOURCE_INDEX),
          actions: [serverLogAction],
          apiKey: await harness.createApiKey(user),
          apiKeyOwner: user.username,
          createdBy: user.username,
        });
      }
    });

    it('enqueues the actions of a rule whose user may execute connectors', async () => {
      const { result } = await harness.run('authorized', RULE_TYPE);
      expect(result).not.toHaveProperty('taskRunError');

      expect(await actionTaskParamsOf('authorized-')).toHaveLength(1);
      const events = await harness.getEventDocs('authorized');
      expect(events.find((doc) => doc.event.action === 'execute')?.event.outcome).toBe('success');
    });

    it('fails the run of a rule whose user may not, after the alerts are stored, as Kibana does', async () => {
      const { result } = await harness.run('unauthorized', RULE_TYPE);
      expect(result).toEqual(expect.objectContaining({ taskRunError: expect.anything() }));

      // The alerts were persisted before the actions were scheduled, and nothing was enqueued.
      expect(await harness.getAlertDocs(ALERTS_INDEX, 'unauthorized')).toHaveLength(1);
      expect(await actionTaskParamsOf('unauthorized-')).toHaveLength(0);
      const events = await harness.getEventDocs('unauthorized');
      const execute = events.find((doc) => doc.event.action === 'execute');
      expect(execute?.event.outcome).toBe('failure');
      expect(execute?.error.message).toContain('Unauthorized to execute');

      // Kibana's own runtime reports the same, for the same rule.
      const inProcess = (await harness.runInProcess('unauthorized', RULE_TYPE)) as never;
      expect(inProcess).toEqual(expect.objectContaining({ taskRunError: expect.anything() }));
      const errors = (
        await harness.getEventDocs('unauthorized', (docs) => docs.length > events.length + 2)
      )
        .filter((doc) => doc.event.action === 'execute')
        .map((doc) => doc.error?.message);
      expect(errors).toHaveLength(2);
      expect(errors[1]).toEqual(errors[0]);
    });
  });

  describe('saved object privileges of the executor', () => {
    beforeAll(async () => {
      await harness.savedObjectsClient.create(
        'index-pattern',
        { title: SOURCE_INDEX, timeFieldName: '@timestamp' },
        { id: 'parity-data-view' }
      );
      for (const [id, user] of [
        ['dv-allowed', executor],
        ['dv-denied', outsider],
      ] as const) {
        await harness.createRule({
          id,
          ruleTypeId: RULE_TYPE,
          params: {
            searchType: 'searchSource',
            searchConfiguration: {
              indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
              query: { query: 'message: hello', language: 'kuery' },
            },
            timeWindowSize: 1,
            timeWindowUnit: 'h',
            threshold: [0],
            thresholdComparator: '>',
            size: 100,
            excludeHitsFromPreviousRun: false,
          },
          references: [
            {
              id: 'parity-data-view',
              name: 'param:kibanaSavedObjectMeta.searchSourceJSON.index',
              type: 'index-pattern',
            },
          ],
          apiKey: await harness.createApiKey(user),
          apiKeyOwner: user.username,
          createdBy: user.username,
        });
      }
    });

    it('reads the data view of a rule as its user: allowed, the rule alerts', async () => {
      const { result } = await harness.run('dv-allowed', RULE_TYPE);
      expect(result).not.toHaveProperty('taskRunError');
      expect(await harness.getAlertDocs(ALERTS_INDEX, 'dv-allowed')).toHaveLength(1);
    });

    it('reads the data view of a rule as its user: denied, the run fails and nothing is alerted', async () => {
      const { result } = await harness.run('dv-denied', RULE_TYPE);
      expect(result).toEqual(expect.objectContaining({ taskRunError: expect.anything() }));
      const events = await harness.getEventDocs('dv-denied');
      const execute = events.find((doc) => doc.event.action === 'execute');
      expect(execute?.event.outcome).toBe('failure');
      expect(execute?.error.message).toMatch(/Unauthorized to get "index-pattern"|index-pattern/);
      expect(await harness.getAlertDocs(ALERTS_INDEX, 'dv-denied')).toHaveLength(0);
    });
  });

  describe('a run that Kibana cancels at its timeout', () => {
    beforeAll(async () => {
      await harness.es.indices.create({
        index: SLOW_INDEX,
        mappings: { properties: { '@timestamp': { type: 'date' } } },
      });
      await harness.es.bulk({
        refresh: 'wait_for',
        operations: Array.from({ length: 1500 }, () => [
          { index: { _index: SLOW_INDEX } },
          { '@timestamp': new Date().toISOString() },
        ]).flat(),
      });
      await harness.createRule({
        id: 'slow',
        ruleTypeId: RULE_TYPE,
        params: ruleParams(SLOW_INDEX, slowQuery),
        actions: [serverLogAction],
      });
    });

    it('is told to cancel, counted as a timeout and not as an execution, and its process ends', async () => {
      const observer = { onResult: jest.fn(), onCancel: jest.fn() };
      const { runner, waitForInFlight } = harness.createRunner('slow', RULE_TYPE, {
        observer,
        timeoutMs: 60000,
      });
      const running = runner.run();
      await waitForInFlight();

      await runner.cancel();
      await running;

      expect(observer.onCancel).toHaveBeenCalledTimes(1);
      expect(observer.onResult).not.toHaveBeenCalled();

      // The process wrote what Kibana's task runner writes when it cancels a rule, and counted it.
      const events = await harness.getEventDocs('slow', (docs) =>
        docs.some((doc) => doc.event.action === 'execute-timeout')
      );
      expect(events.map((doc) => doc.event.action)).toContain('execute-timeout');
      // The process did not outlive the run.
      await harness.waitForNoProcesses();
      expect(harness.supervisor.getStats().live).toBe(0);
    });
  });

  describe('a run of a rule that is not cancelled', () => {
    it('is counted as an execution by Kibana, not as a timeout', async () => {
      const observer = { onResult: jest.fn(), onCancel: jest.fn() };
      await harness.run('authorized', RULE_TYPE, { observer });
      expect(observer.onResult).toHaveBeenCalledTimes(1);
      expect(observer.onCancel).not.toHaveBeenCalled();
    });
  });

  describe("a rule run in the process and one run in the test process (Kibana's runtime)", () => {
    const NAME = 'differential rule';

    beforeAll(async () => {
      for (const id of ['diff-forked', 'diff-in-process']) {
        await harness.createRule({
          id,
          name: NAME,
          ruleTypeId: RULE_TYPE,
          params: ruleParams(SOURCE_INDEX),
          actions: [serverLogAction],
        });
      }
    });

    // The link to an alert encodes the rule and the time range in a compressed state (`lz`): compare the locator.
    const normalize = (value: unknown, ruleId: string) =>
      JSON.parse(JSON.stringify(stripVolatile(value)).split(ruleId).join('<rule>'), (key, item) =>
        key === 'kibana.alert.url' ? String(item).split('&lz=')[0] : item
      );

    it('write the same alert documents, event log, task result and enqueued actions', async () => {
      const forked = await harness.run('diff-forked', RULE_TYPE);
      const inProcess = await harness.runInProcess('diff-in-process', RULE_TYPE);

      const alertsOf = async (id: string) =>
        normalize(await harness.getAlertDocs(ALERTS_INDEX, id), id);
      expect(await alertsOf('diff-forked')).toHaveLength(1);
      expect(await alertsOf('diff-forked')).toEqual(await alertsOf('diff-in-process'));

      const eventsOf = async (id: string) =>
        normalize(
          (await harness.getEventDocs(id, (docs) => docs.length >= 5)).map(summarizeEvent),
          id
        );
      const forkedEvents = await eventsOf('diff-forked');
      expect(forkedEvents.map((e: { action: string }) => e.action)).toEqual([
        'execute-start',
        'new-instance',
        'active-instance',
        'execute-action',
        'execute',
      ]);
      expect(await eventsOf('diff-in-process')).toEqual(forkedEvents);

      expect(normalize(forked.result, 'diff-forked')).toEqual(
        normalize(inProcess, 'diff-in-process')
      );

      const [forkedParams] = await actionTaskParamsOf('diff-forked-');
      const [inProcessParams] = await actionTaskParamsOf('diff-in-process-');
      expect(forkedParams).toBeDefined();
      expect(normalize(forkedParams, 'diff-forked')).toEqual(
        normalize(inProcessParams, 'diff-in-process')
      );
    });

    it('send alert.status.changed through the workflows client a contribution provides (test process only)', async () => {
      emittedEvents.length = 0;
      await harness.createRule({
        id: 'status-changed',
        ruleTypeId: RULE_TYPE,
        params: ruleParams(SOURCE_INDEX),
      });
      await harness.runInProcess('status-changed', RULE_TYPE);

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].triggerId).toBe('alerting.v1.alertStatusChanged');
      expect(emittedEvents[0].payload).toEqual(
        expect.objectContaining({
          rule: expect.objectContaining({ id: 'status-changed' }),
          alert: expect.objectContaining({ id: 'query matched', status: 'active' }),
        })
      );
    });
  });
});
