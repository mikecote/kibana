/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import type { ApiClientFixture, EsClient } from '@kbn/scout';
import { expect } from '@kbn/scout/api';

export const HEADERS = {
  'kbn-xsrf': 'some-xsrf-token',
  'x-elastic-internal-origin': 'kibana',
  'Content-Type': 'application/json;charset=UTF-8',
} as const;

// Mirrors `task_processes` in kbn-scout's config sets.
export const TASK_PROCESSES_DIR = resolve(REPO_ROOT, 'target', 'task_processes_scout');
export const BUNDLE_DIR = resolve(TASK_PROCESSES_DIR, 'bundles');
export const KIBANA_LOG = resolve(TASK_PROCESSES_DIR, 'kibana.log');
export const MAX_CONCURRENT_PROCESSES = 2;

// Rules run in processes that boot, with polls between
export const TEST_TIMEOUT_MS = 300_000;

export const ES_QUERY = '.es-query';
export const INDEX_THRESHOLD = '.index-threshold';

export const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

export interface LogRecord {
  '@timestamp': string;
  message: string;
  log?: { level?: string; logger?: string };
  labels?: Record<string, string>;
  process?: { pid?: number };
}

/** Kibana's log, as the JSON records of the file appender of the config set. */
export const readKibanaLog = (): LogRecord[] => {
  if (!existsSync(KIBANA_LOG)) return [];
  return readFileSync(KIBANA_LOG, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line ? [JSON.parse(line) as LogRecord] : [];
      } catch {
        return [];
      }
    });
};

const isSince = (record: LogRecord, since: string) =>
  Date.parse(record['@timestamp']) >= Date.parse(since);

/** The processes started for a task type since `since`, from the supervisor's debug lines. */
export const getStartedProcesses = (taskType: string, since: string) =>
  readKibanaLog()
    .filter((r) => isSince(r, since))
    .flatMap((r) => {
      const match = r.message.match(
        new RegExp(
          `^Task process (\\d+) started for ${taskType}$|^Task process (\\d+) started for ${taskType};|^Spinning up process (\\d+) for task ${taskType};`
        )
      );
      return match ? [Number(match[1] ?? match[2] ?? match[3])] : [];
    });

export const getDispatchFailures = (taskType: string, reason: string, since: string) =>
  readKibanaLog().filter(
    (r) =>
      isSince(r, since) &&
      r.message.includes(`Task ${taskType} could not run in its task process (${reason})`)
  );

/** Lines a task process wrote, which Kibana logged again with the labels of the run. */
export const getChildLines = (taskType: string, since: string) =>
  readKibanaLog().filter(
    (r) => isSince(r, since) && r.labels?.task_type === taskType && r.labels?.child_logger
  );

/** Observation only: the pids whose command line runs a bundle of this run's directory. */
export const getBundleProcesses = (): number[] => {
  try {
    return execFileSync('pgrep', ['-f', `node .*${BUNDLE_DIR}/[^ ]+\\.m?js`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 without a match
  }
};

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const createEsQueryRule = async (
  apiClient: ApiClientFixture,
  headers: Record<string, string>,
  {
    name,
    actions = [],
    interval = '1m',
    ruleTypeId = ES_QUERY,
  }: { name: string; actions?: unknown[]; interval?: string; ruleTypeId?: string }
) => {
  const response = await apiClient.post('api/alerting/rule', {
    headers,
    responseType: 'json',
    body: {
      name,
      tags: ['task_processes'],
      rule_type_id: ruleTypeId,
      consumer: 'alerts',
      schedule: { interval },
      enabled: true,
      params:
        ruleTypeId === ES_QUERY
          ? {
              searchType: 'esQuery',
              size: 10,
              timeWindowSize: 5,
              timeWindowUnit: 'm',
              thresholdComparator: '>',
              threshold: [-1],
              esQuery: '{"query":{"match_all":{}}}',
              aggType: 'count',
              groupBy: 'all',
              termSize: 5,
              excludeHitsFromPreviousRun: false,
              sourceFields: [],
              index: ['.kibana-event-log-*'],
              timeField: '@timestamp',
            }
          : {
              index: ['.kibana-event-log-*'],
              timeField: '@timestamp',
              aggType: 'count',
              groupBy: 'all',
              termSize: 5,
              timeWindowSize: 5,
              timeWindowUnit: 'm',
              thresholdComparator: '>',
              threshold: [-1],
            },
      actions,
    },
  });
  expect(response).toHaveStatusCode(200);
  return (response.body as { id: string }).id;
};

export const deleteRule = (
  apiClient: ApiClientFixture,
  headers: Record<string, string>,
  id: string
) => apiClient.delete(`internal/alerting/rule/${id}`, { headers });

export const deleteConnector = (
  apiClient: ApiClientFixture,
  headers: Record<string, string>,
  id: string
) => apiClient.delete(`api/actions/connector/${id}`, { headers });

export const createConnector = async (
  apiClient: ApiClientFixture,
  headers: Record<string, string>,
  body: Record<string, unknown>
) => {
  const response = await apiClient.post('api/actions/connector', {
    headers,
    body,
    responseType: 'json',
  });
  expect(response).toHaveStatusCode(200);
  return (response.body as { id: string }).id;
};

/** The `execute` events of a rule in the event log. */
export const getExecutions = async (esClient: EsClient, ruleId: string) => {
  const { hits } = await esClient.search<{
    event?: { outcome?: string };
    kibana?: { alert?: { rule?: { execution?: { uuid?: string } } } };
  }>({
    index: '.kibana-event-log-*',
    size: 100,
    query: {
      bool: {
        filter: [
          { term: { 'event.action': 'execute' } },
          { term: { 'event.provider': 'alerting' } },
          { term: { 'rule.id': ruleId } },
        ],
      },
    },
  });
  return hits.hits.map((hit) => hit._source!);
};

export const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 90_000, intervalMs = 1_000, message = 'condition' } = {}
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${message}`);
};
