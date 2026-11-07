/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { RuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { startRuleProcessHarness } from '@kbn/alerting-plugin/server/task_types/testing/rule_process_harness';
import { ML_ALERT_TYPES } from '../../common/constants/alerts';
import { taskType } from '../task_types/anomaly_detection_jobs_health.task';
import { getMlRuleTestSettings } from './fixtures/ml_rule_test_settings';

const RULE_TYPE = ML_ALERT_TYPES.AD_JOBS_HEALTH;

describe('the anomaly detection jobs health rule type served from a bundle', () => {
  let harness: RuleProcessHarness;

  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      rules: [{ taskType, bundle: 'ml__anomaly_detection_jobs_health' }],
      settings: { ml: await getMlRuleTestSettings() },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('declares the job saved object type its process reads', () => {
    expect(taskType.type).toBe(`alerting:${RULE_TYPE}`);
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
  });

  it('runs the real executor, which reports no problem when there are no jobs', async () => {
    const { forked, inProcess } = await harness.runBoth(
      {
        id: 'jobs-health-no-jobs',
        ruleTypeId: RULE_TYPE,
        params: {
          includeJobs: { jobIds: ['*'], groupIds: [] },
          excludeJobs: null,
          testsConfig: null,
        },
      },
      '.alerts-*'
    );
    expect(forked.alerts).toHaveLength(0);
    expect(forked.events.at(-1)).toEqual(
      expect.objectContaining({ action: 'execute', outcome: 'success' })
    );
    expect(forked).toEqual(inProcess);
  });
});
