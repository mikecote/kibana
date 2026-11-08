/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import { ALERTING_CASES_SAVED_OBJECT_INDEX } from '@kbn/core-saved-objects-server';
import { ES_QUERY_ID, OBSERVABILITY_THRESHOLD_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { alertMappings } from '@kbn/alerting-plugin/common/saved_objects/rules/mappings';
import type { RawRule } from '@kbn/alerting-plugin/server/types';
import { contribution as ruleReaders } from '@kbn/alerting-plugin/server/task_types/workflow_rules_read_contribution';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { contribution } from './__fixtures__/native_rules_read';
import { contribution as streamsServices } from '../workflow_services_contribution';
import {
  streamsConfigurationSavedObjectType,
  streamsUiMetadataSavedObjectType,
} from '../../lib/saved_objects/streams_configuration';
import { STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE } from '../../../common/constants';

const ruleTypes = [ES_QUERY_ID, OBSERVABILITY_THRESHOLD_RULE_TYPE_ID];
const feature = {
  id: 'nativeRules',
  name: 'Native rules',
  category: DEFAULT_APP_CATEGORIES.observability,
  app: [],
  alerting: ruleTypes.map((ruleTypeId) => ({ ruleTypeId, consumers: ['nativeRules'] })),
  privileges: {
    all: { savedObject: { all: [], read: [] }, ui: [] },
    read: { savedObject: { all: [], read: [] }, ui: [] },
  },
};

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native rule reads in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          actionsConnectors: { inMemoryConnectors: [] },
          streamsAgentBuilder: {
            isDev: false,
            canvasEnabled: true,
            canEncrypt: true,
            isServerless: false,
          },
          alertingAuthorizationRuntime: {
            ruleTypes: ruleTypes.map((id) => ({ id })),
            features: [feature],
            spacesEnabled: true,
            securityEnabled: false,
          },
          alertingRuleRead: {
            ruleTypes: ruleTypes.map((id) => ({
              id,
              name: id,
              minimumLicenseRequired: 'basic',
              isExportable: true,
              hasReferenceInjector: true,
              hasViewInAppRelativeUrl: id === OBSERVABILITY_THRESHOLD_RULE_TYPE_ID,
            })),
          },
        },
        savedObjectTypes: [
          streamsConfigurationSavedObjectType,
          streamsUiMetadataSavedObjectType,
          {
            name: 'alert',
            mappings: alertMappings,
            indexPattern: ALERTING_CASES_SAVED_OBJECT_INDEX,
          },
        ],
        seedContributions: { 'workflow-steps': [ruleReaders, streamsServices, contribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, '__fixtures__/native_rules_read.ts')],
        },
        workflows: { read: { steps: [{ name: 'read', type: 'test.sdk.rules_read' }] } },
        seed: async ({ host, es }) => {
          const secrets = JSON.stringify({ token: 'native-canvas-secret' });
          await host.savedObjects
            .getUnsafeInternalClient({
              includedHiddenTypes: [STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE],
            })
            .create(
              STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE,
              {
                unit_id: 'default',
                unit: { sources: [] },
                secrets,
              },
              { id: 'default' }
            );
          await es.indices.refresh({ index: '.kibana' });
          const stored = await es.search({
            index: '.kibana',
            query: { term: { type: STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE } },
          });
          expect(stored.hits.hits).toHaveLength(1);
          expect(JSON.stringify(stored.hits.hits)).not.toContain('native-canvas-secret');
          const repository = host.savedObjects.createInternalRepository(['alert']);
          for (const [id, alertTypeId] of [
            ['query-rule', ES_QUERY_ID],
            ['threshold-rule', OBSERVABILITY_THRESHOLD_RULE_TYPE_ID],
          ]) {
            const attributes: RawRule = {
              legacyId: null,
              name: `Native ${id}`,
              consumer: 'nativeRules',
              alertTypeId,
              enabled: true,
              schedule: { interval: '1m' },
              params: {
                searchType: 'searchSource',
                searchConfiguration: {
                  indexRefName: 'searchSource.index',
                  query: { language: 'kuery', query: '' },
                },
              },
              actions: [],
              tags: [],
              createdAt: '2026-11-08T00:00:00.000Z',
              updatedAt: '2026-11-08T00:00:00.000Z',
              createdBy: 'elastic',
              updatedBy: 'elastic',
              apiKey: 'must-not-leave-rule-client',
              apiKeyOwner: 'elastic',
              throttle: null,
              muteAll: false,
              mutedInstanceIds: [],
              notifyWhen: 'onActiveAlert',
              executionStatus: {
                status: 'ok',
                lastExecutionDate: '2026-11-08T00:00:00.000Z',
                error: null,
                warning: null,
              },
              revision: 0,
            };
            await repository.create('alert', attributes, {
              id,
              references: [
                { name: 'param:searchSource.index', type: 'index-pattern', id: 'native-data-view' },
              ],
            });
            await repository.create(
              'alert',
              { ...attributes, name: `Foreign ${id}` },
              { id: `foreign-${id}`, namespace: 'foreign' }
            );
          }
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('restores references and URLs for scoped rule reads and Streams suggestions without Main calls', async () => {
      const seen = new Set<string>();
      for (let run = 0; run < 3; run++) {
        await harness.run('read');
        const execution = (await harness.executionsOf('read')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('The native rule reader did not execute');
        seen.add(execution.id);
        const [step] = await harness.stepsOf(execution.id);
        expect(step.error).toBeUndefined();
        expect(execution.status).toBe('completed');
        expect(step.output.output ?? step.output).toEqual({
          index: 'native-data-view',
          names: ['Native query-rule', 'Native threshold-rule'],
          url: '/app/rules/rule/threshold-rule',
          attachmentNames: ['Native query-rule', 'Native threshold-rule'],
          suggestions: ['Native query-rule', 'Native threshold-rule'],
          hasApiKey: false,
          foreignVisible: false,
          canvasSecret: 'native-canvas-secret',
        });
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
