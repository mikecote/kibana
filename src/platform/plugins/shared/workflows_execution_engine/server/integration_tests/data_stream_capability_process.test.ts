/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License, v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import { TASK_DATA_STREAM_NAME } from './fixtures/data_stream_contribution';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Core data streams in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/data_stream_contribution.ts')],
        },
        workflows: {
          boot: { steps: [{ name: 'boot', type: 'console', with: { message: 'Booted' } }] },
          read: { steps: [{ name: 'read', type: 'test.data_stream.execute', with: {} }] },
          write: {
            steps: [{ name: 'write', type: 'test.data_stream.execute', with: { write: true } }],
          },
          undeclared: {
            steps: [
              { name: 'read', type: 'test.data_stream.execute', with: { unregistered: true } },
            ],
          },
        },
      });
    }, 240000);

    afterAll(async () => {
      await harness?.stop();
    });

    it('leaves startup untouched, then initializes and uses only the declared stream on demand', async () => {
      const onDispatchFailure = jest.fn();
      await harness.run('boot', onDispatchFailure);
      expect(await harness.es.indices.exists({ index: TASK_DATA_STREAM_NAME })).toBe(false);
      expect(await harness.es.indices.existsIndexTemplate({ name: TASK_DATA_STREAM_NAME })).toBe(
        false
      );

      await harness.run('read', onDispatchFailure);
      const [initialRead] = await harness.executionsOf('read');
      expect({ status: initialRead.status, error: initialRead.error }).toEqual({
        status: 'completed',
        error: undefined,
      });
      const [initialStep] = await harness.stepsOf(initialRead.id);
      expect(initialStep.output.output ?? initialStep.output).toEqual({ total: 0 });
      expect(await harness.es.indices.exists({ index: TASK_DATA_STREAM_NAME })).toBe(true);

      await harness.run('write', onDispatchFailure);
      await harness.run('write', onDispatchFailure);
      await harness.run('read', onDispatchFailure);
      const reads = await harness.executionsOf('read');
      expect(reads).toHaveLength(2);
      const [finalRead] = reads.filter(({ id }) => id !== initialRead.id);
      expect(finalRead).toEqual(expect.objectContaining({ status: 'completed' }));
      const [finalStep] = await harness.stepsOf(finalRead.id);
      expect(finalStep.output.output ?? finalStep.output).toEqual({ total: 2 });
      const documents = await harness.es.search({ index: TASK_DATA_STREAM_NAME, size: 10 });
      expect(documents.hits.hits).toHaveLength(2);
      for (const hit of documents.hits.hits) {
        expect(hit._source).toEqual(
          expect.objectContaining({ kibana: { space_ids: ['default'] } })
        );
      }
      await harness.run('undeclared', onDispatchFailure);
      const [failure] = await harness.executionsOf('undeclared');
      expect(failure.status).toBe('failed');
      expect(JSON.stringify(failure.error)).toContain('not registered');
      expect(await harness.es.indices.exists({ index: '.task-process-undeclared-data' })).toBe(
        false
      );
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 6);
      expect(harness.kibanaRequests).toEqual([]);
      expect(onDispatchFailure).not.toHaveBeenCalled();
    }, 120000);
  }
);
