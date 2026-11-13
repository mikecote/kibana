/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import { z } from '@kbn/zod/v4';
import { startRuleProcessHarness } from '../rule_process_harness';
import type { RuleProcessHarness } from '../rule_process_harness';
import { taskType } from './fixtures/native_url_task';

const modes = [
  { mode: 'child_process', reuse: false },
  { mode: 'child_process', reuse: true },
  { mode: 'remote', reuse: false },
  { mode: 'remote', reuse: true },
] as const;
const resultSchema = z.object({
  state: z.object({
    alertTypeState: z.object({
      id: z.string(),
      slug: z.string(),
      dashboardId: z.literal('native-dashboard'),
      removed: z.boolean(),
      completedRuns: z.number().int().nonnegative(),
    }),
  }),
});

describe.each(modes)('Native rule short URLs in $mode/$reuse', ({ mode, reuse }) => {
  let harness: RuleProcessHarness;
  beforeAll(async () => {
    harness = await startRuleProcessHarness({
      mode,
      reuse,
      rules: [
        {
          taskType,
          bundle: 'native_rule_url',
          file: join(__dirname, 'fixtures/native_url_task.ts'),
        },
      ],
    });
    await harness.createRule({ id: 'create-url', ruleTypeId: 'test.native-url', params: {} });
  });
  afterAll(async () => {
    await harness?.stop();
  });

  it('stores native locator references, reads them in a second run and deletes the URL', async () => {
    const created = await harness.run('create-url', 'test.native-url');
    expect(created.onDispatchFailure).not.toHaveBeenCalled();
    const first = resultSchema.parse(created.result).state.alertTypeState;
    expect(first.completedRuns).toBe(0);
    const repository = harness.seeder.host.savedObjects.getUnsafeInternalClient();
    const stored = await repository.get<{ slug: string; locatorJSON: string; accessCount: number }>(
      'url',
      first.id
    );
    expect(stored.attributes.slug).toBe(first.slug);
    expect(stored.attributes.accessCount).toBe(1);
    expect(stored.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'native-dashboard', type: 'dashboard' }),
      ])
    );
    expect(JSON.parse(stored.attributes.locatorJSON)).toEqual(
      expect.objectContaining({ state: { dashboardId: '' } })
    );
    for (const remove of [false, true]) {
      const id = remove ? 'delete-url' : 'read-url';
      await harness.createRule({
        id,
        ruleTypeId: 'test.native-url',
        params: { sourceId: first.id, remove },
      });
      const outcome = await harness.run(id, 'test.native-url');
      expect(outcome.onDispatchFailure).not.toHaveBeenCalled();
      expect(resultSchema.parse(outcome.result).state.alertTypeState).toEqual({
        ...first,
        removed: remove,
        completedRuns: reuse ? (remove ? 2 : 1) : 0,
      });
      if (!remove) {
        const updated = await repository.get<{ accessCount: number }>('url', first.id);
        expect(updated.attributes.accessCount).toBe(2);
      }
    }
    await expect(repository.get('url', first.id)).rejects.toThrow(/not found/i);
  });
});
