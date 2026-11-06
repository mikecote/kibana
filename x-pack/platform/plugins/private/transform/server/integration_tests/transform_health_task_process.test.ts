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
import { taskType } from '../task_types/transform_health.task';

const RULE_TYPE = 'transform_health';
const ALERTS_INDEX = '.alerts-*';

/**
 * The transform health rule type from its own bundle, forked the way Kibana does, against a real
 * Elasticsearch with a transform that is created and never started: the "not started" check alerts.
 */
describe('the transform_health rule type served from a bundle', () => {
  let harness: RuleProcessHarness;

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'transform__transform_health' }],
    });
    await harness.es.indices.create({
      index: 'transform-source',
      mappings: { properties: { host: { type: 'keyword' }, '@timestamp': { type: 'date' } } },
    });
    await harness.es.transform.putTransform({
      transform_id: 'stopped-transform',
      source: { index: 'transform-source' },
      dest: { index: 'transform-dest' },
      pivot: {
        group_by: { host: { terms: { field: 'host' } } },
        aggregations: { latest: { max: { field: '@timestamp' } } },
      },
    });
    for (const [id, include] of [
      ['transform-alerting', 'stopped-*'],
      ['transform-quiet', 'no-such-transform-*'],
    ]) {
      await harness.createRule({
        id,
        ruleTypeId: RULE_TYPE,
        params: {
          includeTransforms: [include],
          testsConfig: { notStarted: { enabled: true } },
        },
      });
    }
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('alerts for a transform that is not started, as Kibana does', async () => {
    const forkedId = 'transform-alerting';
    const { fallback, result } = await harness.run(forkedId, RULE_TYPE);
    expect(fallback).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('taskRunError');
    expect(await harness.getAlertDocs(ALERTS_INDEX, forkedId)).toHaveLength(1);

    const execute = (await harness.getEventDocs(forkedId)).find(
      (doc) => doc.event.action === 'execute'
    );
    expect(execute?.event.outcome).toBe('success');
  });

  it("agrees with the run of Kibana's own runtime, for an alerting and a quiet rule", async () => {
    for (const [id, alerts] of [
      ['transform-alerting', 1],
      ['transform-quiet', 0],
    ] as const) {
      const { forked, inProcess } = await harness.runBoth(
        {
          id: `${id}-compare`,
          ruleTypeId: RULE_TYPE,
          params: {
            includeTransforms: [id === 'transform-alerting' ? 'stopped-*' : 'no-such-transform-*'],
            testsConfig: { notStarted: { enabled: true } },
          },
        },
        ALERTS_INDEX
      );
      expect(forked.alerts).toHaveLength(alerts);
      expect(forked.events.at(-1)).toEqual(
        expect.objectContaining({ action: 'execute', outcome: 'success' })
      );
      expect(forked).toEqual(inProcess);
    }
  });
});
