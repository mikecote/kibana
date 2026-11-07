/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import {
  WORKFLOW_PROCESS_TEST_MODES,
  startWorkflowProcessHarness,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { contribution } from '../workflow_services_contribution';
import {
  NIGHTSHIFT_SOURCE_SO_TYPE,
  nightshiftSourceSavedObjectType,
} from '../../saved_objects/nightshift_source_saved_object';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'source catalog in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: { nightshiftSourcesRuntime: { enabled: true } },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/source_workflow_contribution.ts')],
        },
        savedObjectTypes: [nightshiftSourceSavedObjectType],
        seedContributions: { 'workflow-steps': [contribution] },
        workflows: {
          disable: {
            steps: [{ name: 'update', type: 'test.source.update', with: { enabled: false } }],
          },
          enable: {
            steps: [{ name: 'update', type: 'test.source.update', with: { enabled: true } }],
          },
        },
        seed: async ({ host }) => {
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: [NIGHTSHIFT_SOURCE_SO_TYPE] })
            .create(
              NIGHTSHIFT_SOURCE_SO_TYPE,
              {
                title: 'Logs',
                esql: 'FROM logs-*',
                type: 'logs',
                tags: [],
                slug: 'logs',
                view_name: '$.nightshift.sources.default.logs',
                enabled: true,
                created_by: 'elastic',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                esql_updated_at: new Date().toISOString(),
              },
              { id: 'source-1' }
            );
        },
      });
    }, 240000);
    afterAll(async () => {
      await harness?.stop();
    });
    it('updates the source and awaits each change listener without retaining listeners across runs', async () => {
      for (const id of ['disable', 'enable']) {
        await harness.run(id);
        const [execution] = await harness.executionsOf(id);
        expect(execution).toMatchObject({ status: 'completed' });
      }
      const events = await harness.es.search({ index: 'test-source-events', size: 10 });
      expect(events.hits.hits).toHaveLength(2);
      expect(events.hits.hits.map(({ _source }) => _source)).toEqual(
        expect.arrayContaining([
          { type: 'updated', enabled: false, spaceId: 'default' },
          { type: 'updated', enabled: true, spaceId: 'default' },
        ])
      );
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 2);
      expect(harness.kibanaRequests).toEqual([]);
    }, 120000);
  }
);
