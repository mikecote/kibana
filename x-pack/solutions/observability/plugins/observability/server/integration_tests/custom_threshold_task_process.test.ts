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
import { OBSERVABILITY_THRESHOLD_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { config } from '..';
import { taskType } from '../task_types/custom_threshold.task';

const ALERTS_INDEX = '.alerts-observability.threshold.alerts-*';
const SOURCE_INDEX = 'custom-threshold-source';
const DATA_VIEW_ID = 'custom-threshold-view';

/**
 * The custom threshold rule type from its own bundle, forked the way Kibana does, against a real
 * Elasticsearch with a data view and a few documents. Each run is compared with the same rule run in
 * the test process, as Kibana's runtime does.
 */
describe('the custom threshold rule type served from a bundle', () => {
  let harness: RuleProcessHarness;

  const rule = (id: string, threshold: number) => ({
    id,
    ruleTypeId: OBSERVABILITY_THRESHOLD_RULE_TYPE_ID,
    consumer: 'infrastructure',
    params: {
      criteria: [
        {
          comparator: '>',
          threshold: [threshold],
          timeSize: 1,
          timeUnit: 'h',
          metrics: [{ name: 'A', aggType: 'count' }],
        },
      ],
      alertOnNoData: false,
      alertOnGroupDisappear: false,
      searchConfiguration: {
        indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
        query: { query: '', language: 'kuery' },
      },
    },
    references: [
      {
        id: DATA_VIEW_ID,
        name: 'param:kibanaSavedObjectMeta.searchSourceJSON.index',
        type: 'index-pattern',
      },
    ],
  });

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'observability__custom_threshold' }],
      // What Kibana sends for the custom threshold rule type: the config of observability.
      settings: { observability: (config.schema as any).validate({}) },
      indices: {
        [SOURCE_INDEX]: {
          properties: { '@timestamp': { type: 'date' }, message: { type: 'keyword' } },
        },
      },
    });
    await harness.savedObjectsClient.create(
      'index-pattern',
      { title: SOURCE_INDEX, timeFieldName: '@timestamp' },
      { id: DATA_VIEW_ID }
    );
    await harness.es.bulk({
      refresh: 'wait_for',
      operations: [1, 2, 3].flatMap((i) => [
        { create: { _index: SOURCE_INDEX } },
        { '@timestamp': new Date().toISOString(), message: `doc ${i}` },
      ]),
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts when the document count is over the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(rule('custom-threshold', 1), ALERTS_INDEX);
    expect(forked.alerts).toHaveLength(1);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });

  it('runs to a success without an alert when the count stays under the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      rule('custom-threshold-quiet', 100),
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(0);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });
});
