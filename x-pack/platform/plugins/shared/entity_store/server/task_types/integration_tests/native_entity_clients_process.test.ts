/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { EntityMaintainerTaskStatus } from '../../tasks/entity_maintainers/types';
import { contribution as entityStore } from '../workflow_steps_contribution';
import { ENTITY_STORE_RUNTIME_SETTINGS_ID } from '../../create_entity_store_client_services';
import { EntityResolutionRuleType } from '../../domain/resolution/rules/saved_object';
import { CustomResolutionRuleType } from '../../domain/resolution/rules';
import {
  getLatestEntitiesIndexName,
  getEntitiesAlias,
  ENTITY_METADATA,
} from '../../../common/domain/entity_index';
import { contribution } from './__fixtures__/native_entity_clients';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native entity SDK in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      const relationshipsAlias = getEntitiesAlias(ENTITY_METADATA, 'default');
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          [ENTITY_STORE_RUNTIME_SETTINGS_ID]: {
            maintainers: [{ id: 'risk-score', interval: '1m', minLicense: 'basic' }],
          },
        },
        savedObjectTypes: [EntityResolutionRuleType, CustomResolutionRuleType],
        seedContributions: { 'workflow-steps': [entityStore, contribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, '__fixtures__/native_entity_clients.ts')],
        },
        registerTaskSchedulingDefinitions: (definitions) =>
          definitions.registerTaskDefinitions({
            'entity-test:maintainer': { title: 'Native maintainer status fixture' },
          }),
        workflows: Object.fromEntries(
          [true, false].map((enabled) => [
            String(enabled),
            { steps: [{ name: 'use_sdk', type: 'test.sdk.entity_clients', with: { enabled } }] },
          ])
        ),
        seed: async ({ es, host }) => {
          const index = getLatestEntitiesIndexName('default');
          await es.indices.create({
            index,
            mappings: {
              properties: {
                'entity.id': { type: 'keyword' },
                'entity.EngineMetadata.Type': { type: 'keyword' },
                'entity.relationships.resolution.resolved_to': { type: 'keyword' },
              },
            },
          });
          for (const name of ['target', 'alias'])
            await es.index({
              index,
              id: `host:${name}`,
              document: { entity: { id: `host:${name}`, name, EngineMetadata: { Type: 'host' } } },
              refresh: 'wait_for',
            });
          await es.indices.create({
            index: `${relationshipsAlias}-fixture`,
            aliases: { [relationshipsAlias]: {} },
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                'event.action': { type: 'keyword' },
                'entity.id': { type: 'keyword' },
                'entity.relationships.owns.target': { type: 'keyword' },
              },
            },
          });
          await es.index({
            index: relationshipsAlias,
            document: {
              '@timestamp': new Date().toISOString(),
              'event.kind': 'event',
              'event.action': 'relationship_observed',
              'entity.id': 'host:target',
              'entity.source': 'native-sdk',
              'entity.relationships.owns.target': 'host:alias',
              Maintainer: { kind: 'owns', scan_id: 'native', lookback_window: '1d' },
            },
            refresh: 'wait_for',
          });
          if (!host.taskManager) throw new Error('Native maintainer status requires Task Manager');
          await host.taskManager.schedule({
            id: 'risk-score:default',
            taskType: 'entity-test:maintainer',
            params: {},
            state: {
              taskStatus: EntityMaintainerTaskStatus.STARTED,
              metadata: { lastSuccessTimestamp: '2026-11-08T00:00:00.000Z' },
              state: {},
            },
          });
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('uses native resolution writes, scoped relationship reads and captured maintainer status', async () => {
      const seen = new Set<string>();
      for (const enabled of [true, false, true]) {
        const id = String(enabled);
        await harness.run(id);
        const execution = (await harness.executionsOf(id)).find(
          ({ id: executionId }) => !seen.has(executionId)
        );
        if (!execution) throw new Error('The entity workflow did not execute');
        seen.add(execution.id);
        const [step] = await harness.stepsOf(execution.id);
        expect(step.error).toBeUndefined();
        expect(execution.status).toBe('completed');
        expect(step.output.output ?? step.output).toEqual({
          enabled,
          aliases: 1,
          relationships: 1,
          maintainers: ['risk-score:started:2026-11-08T00:00:00.000Z'],
        });
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
