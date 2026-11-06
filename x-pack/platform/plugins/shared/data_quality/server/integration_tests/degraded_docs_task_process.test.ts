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

import { DEGRADED_DOCS_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { startRuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { taskType } from '../task_types/degraded_docs.task';

const ALERTS_INDEX = '.alerts-*';

/**
 * The degraded docs (data quality) rule type from its own bundle, forked the way Kibana does, against a
 * real Elasticsearch with an index that holds documents Elasticsearch ignored a field of.
 */
describe('the degraded docs rule type served from a bundle', () => {
  let harness: RuleProcessHarness;

  const params = (index: string, threshold: number) => ({
    timeUnit: 'h',
    timeSize: 1,
    threshold: [threshold],
    comparator: '>',
    searchConfiguration: { index },
  });

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'dataQuality__degraded_docs' }],
    });
    await harness.es.indices.create({
      index: 'logs-degraded-test',
      mappings: {
        properties: {
          '@timestamp': { type: 'date' },
          value: { type: 'integer', ignore_malformed: true },
        },
      },
    });
    await harness.es.index({
      index: 'logs-degraded-test',
      refresh: 'wait_for',
      // Not a number: Elasticsearch ignores the field and lists it in `_ignored`.
      document: { '@timestamp': new Date().toISOString(), value: 'not a number' },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts when documents are degraded, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'degraded',
        ruleTypeId: DEGRADED_DOCS_RULE_TYPE_ID,
        params: params('logs-degraded-test', 0),
      },
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(1);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });

  it('runs to a success without an alert below the threshold, as Kibana does', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'healthy',
        ruleTypeId: DEGRADED_DOCS_RULE_TYPE_ID,
        params: params('logs-degraded-test', 100),
      },
      ALERTS_INDEX
    );
    expect(forked.alerts).toHaveLength(0);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });
});
