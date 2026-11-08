/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'path';
import type { TaskFeatureFlagDefinitions } from '@kbn/task-manager-plugin/server/task_process/feature_flag_declarations';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native SDK flags in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let values = { enabled: false, limit: 0, mode: '' };
    const evaluate = jest.fn(async (_type: string, defaults: TaskFeatureFlagDefinitions = {}) => ({
      ...defaults,
      'test.sdk.enabled': values.enabled,
      'test.sdk.limit': values.limit,
      'test.sdk.mode': values.mode,
    }));
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        getFeatureFlags: evaluate,
        additionalContributions: {
          'workflow-steps': [join(__dirname, '__fixtures__/native_sdk_feature_flags.ts')],
        },
        workflows: {
          flags: { steps: [{ name: 'use_sdk', type: 'test.sdk.feature_flags', with: {} }] },
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('uses newly evaluated values for retained jobs and preserves false, zero and strings', async () => {
      const seen = new Set<string>();
      for (values of [
        { enabled: false, limit: 0, mode: '' },
        { enabled: true, limit: 2.5, mode: '123' },
        { enabled: false, limit: 0, mode: 'true' },
      ]) {
        await harness.run('flags');
        const executions = await harness.executionsOf('flags');
        const execution = executions.find(({ id }) => !seen.has(id));
        expect(execution).toEqual(expect.objectContaining({ status: 'completed' }));
        if (!execution) throw new Error('The workflow execution is missing');
        seen.add(execution.id);
        const [step] = await harness.stepsOf(execution.id);
        expect(step.output.output ?? step.output).toEqual(values);
      }
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(evaluate.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          'test.sdk.enabled': false,
          'test.sdk.limit': 12.5,
          'test.sdk.mode': 'true',
        })
      );
      const effects = await harness.es.search<{ limit: number; mode: string }>({
        index: 'native-sdk-feature-effects',
        query: { match_all: {} },
      });
      expect(effects.hits.hits.map(({ _source }) => _source)).toEqual([
        { limit: 2.5, mode: '123' },
      ]);
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
