/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

const { parentPort, workerData } = require('node:worker_threads');
const { Client } = require('@elastic/elasticsearch');

const esClient = new Client({
  node: 'http://127.0.0.1:9200',
  auth: {
    username: 'kibana',
    password: 'changeme',
  },
});

const { availableCapacity, claimOwnershipUntil, costMap, claimBatches, unusedTypes, ownerId } =
  workerData;

(async () => {
  const results = await Promise.all(
    claimBatches
      .map((batch) => {
        if (batch.size > 0) {
          return searchForTasks(batch.size, batch.types);
        }
      })
      .filter((p) => !!p)
  );

  const bulkUpdateRows = [];
  let remainingCapacity = availableCapacity;
  for (const result of results) {
    for (const hit of result) {
      const task = hit._source.task;
      if (remainingCapacity - costMap[task.taskType] >= 0) {
        bulkUpdateRows.push({
          update: {
            _id: hit._id,
            _index: hit._index,
            if_seq_no: hit._seq_no,
            if_primary_term: hit._primary_term,
          },
        });
        if (unusedTypes.includes(task.taskType)) {
          bulkUpdateRows.push({
            doc: {
              'task.status': 'unrecognized',
            },
          });
        } else {
          bulkUpdateRows.push({
            doc: {
              'task.scheduledAt':
                task.retryAt && task.retryAt < new Date() ? task.retryAt : task.runAt,
              'task.status': 'claiming',
              'task.ownerId': ownerId,
              'task.retryAt': claimOwnershipUntil,
            },
          });
          remainingCapacity -= costMap[task.taskType];
        }
      }
    }
  }

  console.log('bulkUpdateRows', JSON.stringify(bulkUpdateRows, null, 2));

  if (bulkUpdateRows.length === 0) {
    parentPort?.postMessage({ taskIdsClaimed: [] });
    process.exit(0);
  }

  const result = await esClient.bulk({ body: bulkUpdateRows });
  console.log(JSON.stringify(result, null, 2));
  parentPort?.postMessage({
    taskIdsClaimed: result.items
      .filter((item) => item.update.status === 200)
      .map((item) => item.update._id.substring(5)),
  });
  process.exit();
})();

async function searchForTasks(size, types) {
  const searchResult = await esClient.search({
    index: '.kibana_task_manager',
    ignore_unavailable: true,
    body: {
      query: {
        bool: {
          must: [
            {
              term: {
                type: 'task',
              },
            },
            {
              bool: {
                must: [
                  {
                    bool: {
                      must: [
                        {
                          term: {
                            'task.enabled': true,
                          },
                        },
                      ],
                    },
                  },
                  {
                    bool: {
                      should: [
                        {
                          bool: {
                            must: [
                              {
                                term: {
                                  'task.status': 'idle',
                                },
                              },
                              {
                                range: {
                                  'task.runAt': {
                                    lte: 'now',
                                  },
                                },
                              },
                            ],
                          },
                        },
                        {
                          bool: {
                            must: [
                              {
                                bool: {
                                  should: [
                                    {
                                      term: {
                                        'task.status': 'running',
                                      },
                                    },
                                    {
                                      term: {
                                        'task.status': 'claiming',
                                      },
                                    },
                                  ],
                                },
                              },
                              {
                                range: {
                                  'task.retryAt': {
                                    lte: 'now',
                                  },
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                  {
                    bool: {
                      should: [
                        {
                          terms: {
                            'task.taskType': types,
                          },
                        },
                      ],
                    },
                  },
                ],
                filter: [
                  {
                    bool: {
                      must_not: [
                        {
                          bool: {
                            should: [
                              {
                                term: {
                                  'task.status': 'running',
                                },
                              },
                              {
                                term: {
                                  'task.status': 'claiming',
                                },
                              },
                            ],
                            must: {
                              range: {
                                'task.retryAt': {
                                  gt: 'now',
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      sort: [
        {
          _script: {
            type: 'number',
            order: 'asc',
            script: {
              lang: 'painless',
              source: `\nif (doc['task.retryAt'].size()!=0) {\n  return doc['task.retryAt'].value.toInstant().toEpochMilli();\n}\nif (doc['task.runAt'].size()!=0) {\n  return doc['task.runAt'].value.toInstant().toEpochMilli();\n}\n    `,
            },
          },
        },
      ],
      size,
      seq_no_primary_term: true,
    },
  });

  return searchResult.hits.hits;
}
