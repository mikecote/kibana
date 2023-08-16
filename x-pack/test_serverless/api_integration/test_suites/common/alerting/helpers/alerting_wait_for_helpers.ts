/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import pRetry from 'p-retry';
import type { SuperTest, Test } from 'supertest';
import type { Client } from '@elastic/elasticsearch';
import type {
  AggregationsAggregate,
  SearchResponse,
} from '@elastic/elasticsearch/lib/api/typesWithBodyKey';

export async function waitForDocumentInIndex({
  esClient,
  indexName,
  num = 1,
}: {
  esClient: Client;
  indexName: string;
  num?: number;
}): Promise<SearchResponse> {
  return await pRetry(
    async () => {
      const response = await esClient.search({ index: indexName });
      if (response.hits.hits.length < num) {
        throw new Error('No hits found');
      }
      return response;
    },
    { retries: 10 }
  );
}

export async function getDocumentsInIndex({
  esClient,
  indexName,
}: {
  esClient: Client;
  indexName: string;
}): Promise<SearchResponse> {
  return await esClient.search({ index: indexName });
}

export async function createIndex({
  esClient,
  indexName,
}: {
  esClient: Client;
  indexName: string;
}) {
  return await esClient.indices.create(
    {
      index: indexName,
      body: {},
    },
    { meta: true }
  );
}

export async function waitForAlertInIndex<T>({
  esClient,
  indexName,
  ruleId,
}: {
  esClient: Client;
  indexName: string;
  ruleId: string;
}): Promise<SearchResponse<T, Record<string, AggregationsAggregate>>> {
  return pRetry(
    async () => {
      const response = await esClient.search<T>({
        index: indexName,
        body: {
          query: {
            term: {
              'kibana.alert.rule.uuid': ruleId,
            },
          },
        },
      });
      if (response.hits.hits.length === 0) {
        throw new Error('No hits found');
      }
      return response;
    },
    { retries: 10 }
  );
}

export async function waitForAllTasksIdle({
  esClient,
  filter,
}: {
  esClient: Client;
  filter: Date;
}): Promise<SearchResponse> {
  return pRetry(
    async () => {
      const response = await esClient.search({
        index: '.kibana_task_manager',
        body: {
          query: {
            bool: {
              must: [
                {
                  terms: {
                    'task.scope': ['actions', 'alerting'],
                  },
                },
                {
                  range: {
                    'task.scheduledAt': {
                      gte: filter.getTime().toString(),
                    },
                  },
                },
              ],
              must_not: [
                {
                  term: {
                    'task.status': 'idle',
                  },
                },
              ],
            },
          },
        },
      });
      if (response.hits.hits.length !== 0) {
        throw new Error(`Expected 0 hits but received ${response.hits.hits.length}`);
      }
      return response;
    },
    { retries: 10 }
  );
}

export async function waitForAllTasks({
  esClient,
  filter,
  taskType,
  attempts,
}: {
  esClient: Client;
  filter: Date;
  taskType: string;
  attempts: number;
}): Promise<SearchResponse> {
  return pRetry(
    async () => {
      const response = await esClient.search({
        index: '.kibana_task_manager',
        body: {
          query: {
            bool: {
              must: [
                {
                  term: {
                    'task.status': 'idle',
                  },
                },
                {
                  term: {
                    'task.attempts': attempts,
                  },
                },
                {
                  terms: {
                    'task.scope': ['actions', 'alerting'],
                  },
                },
                {
                  term: {
                    'task.taskType': taskType,
                  },
                },
                {
                  range: {
                    'task.scheduledAt': {
                      gte: filter.getTime().toString(),
                    },
                  },
                },
              ],
            },
          },
        },
      });
      if (response.hits.hits.length === 0) {
        throw new Error('No hits found');
      }
      return response;
    },
    { retries: 10 }
  );
}

export async function waitForDisabled({
  esClient,
  ruleId,
  filter,
}: {
  esClient: Client;
  ruleId: string;
  filter: Date;
}): Promise<SearchResponse> {
  return pRetry(
    async () => {
      const response = await esClient.search({
        index: '.kibana_task_manager',
        body: {
          query: {
            bool: {
              must: [
                {
                  term: {
                    'task.id': `task:${ruleId}`,
                  },
                },
                {
                  terms: {
                    'task.scope': ['actions', 'alerting'],
                  },
                },
                {
                  range: {
                    'task.scheduledAt': {
                      gte: filter.getTime().toString(),
                    },
                  },
                },
                {
                  term: {
                    'task.enabled': true,
                  },
                },
              ],
            },
          },
        },
      });
      if (response.hits.hits.length !== 0) {
        throw new Error(`Expected 0 hits but received ${response.hits.hits.length}`);
      }
      return response;
    },
    { retries: 10 }
  );
}

export async function waitForEventLog({
  esClient,
  provider,
  filter,
  num = 1,
}: {
  esClient: Client;
  provider: string;
  filter: Date;
  num?: number;
}): Promise<SearchResponse> {
  return pRetry(
    async () => {
      const response = await esClient.search({
        index: '.kibana-event-log*',
        body: {
          query: {
            bool: {
              filter: [
                {
                  term: {
                    'event.provider': {
                      value: provider,
                    },
                  },
                },
                {
                  term: {
                    'event.action': 'execute',
                  },
                },
                {
                  range: {
                    '@timestamp': {
                      gte: filter.getTime().toString(),
                    },
                  },
                },
              ],
            },
          },
        },
      });
      if (response.hits.hits.length < num) {
        throw new Error('No hits found');
      }
      return response;
    },
    { retries: 10 }
  );
}

export async function waitForNumRuleRuns({
  supertest,
  numOfRuns,
  ruleId,
  esClient,
  testStart,
}: {
  supertest: SuperTest<Test>;
  numOfRuns: number;
  ruleId: string;
  esClient: Client;
  testStart: Date;
}) {
  for (let i = 0; i < numOfRuns; i++) {
    await pRetry(
      async () => {
        const runSoonResponse = await supertest
          .post(`/internal/alerting/rule/${ruleId}/_run_soon`)
          .set('kbn-xsrf', 'foo')
          .set('x-elastic-internal-origin', 'foo');
        if (runSoonResponse.status !== 204) {
          throw new Error(`Expected ${runSoonResponse.status} to equal 204`);
        }
        await waitForEventLog({
          esClient,
          provider: 'alerting',
          filter: testStart,
          num: i + 1,
        });
        await waitForAllTasksIdle({ esClient, filter: testStart });
      },
      { retries: 10 }
    );
  }
}
