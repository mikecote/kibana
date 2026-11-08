/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import { config as fleetConfig } from '@kbn/fleet-plugin/server/config';
import { coreMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { configSchema as agentBuilderConfig } from '@kbn/agent-builder-plugin/server/config';
import { getAgentBuilderRunSettings } from '@kbn/agent-builder-plugin/server/run_services/run_settings';
import {
  getLatestEntitiesIndexName,
  getEntitiesAlias,
  ENTITY_LATEST,
} from '@kbn/entity-store/server';
import { EntityResolutionRuleType } from '@kbn/entity-store/server/domain/resolution/rules/saved_object';
import { CustomResolutionRuleType } from '@kbn/entity-store/server/domain/resolution/rules';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { getRiskIndex } from '../../../common/search_strategy/security_solution/risk_score/common';
import { createMockConfig } from '../../config.mock';
import { contribution as security } from '../agent_builder_contribution';
import type { SecurityAgentBuilderSettings } from '../agent_builder_settings';
import { SECURITY_AGENT_BUILDER_SETTINGS_ID } from '../agent_builder_settings';
import { contribution } from './fixtures/native_security_core_tools';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Security core tools in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    const logger = loggerMock.create();
    const config = createMockConfig();
    const snapshot: SecurityAgentBuilderSettings = {
      config: {
        ...config,
        experimentalFeatures: {
          ...config.experimentalFeatures,
          entityAnalyticsEntityStoreV2: true,
        },
      },
      productFeatures: { enabledProductFeatureKeys: [], registeredActions: [] },
      isServerless: false,
      canEncrypt: true,
      cpsAvailable: false,
      plugins: { ml: false, security: true, osquery: false, llmTasks: false },
    };
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger,
        savedObjectTypes: [EntityResolutionRuleType, CustomResolutionRuleType],
        settings: {
          [SECURITY_AGENT_BUILDER_SETTINGS_ID]: snapshot,
          fleetPackageMetadata: {
            config: fleetConfig.schema.validate({}),
            assets: { bundledPackages: [] },
            elasticConnectorsServerlessEnabled: false,
            kibanaBranch: 'main',
            isProductionMode: false,
            isFipsEnabled: false,
          },
          dataViewsRuntime: {
            scriptedFieldsEnabled: false,
            rollupsEnabled: false,
            dataTiersExcludedForFields: true,
            fieldListCachingEnabled: true,
          },
          dataSearchRuntime: {
            multiSearchDocLink: coreMock.createSetup().docLinks.links.apis.multiSearch,
            search: {
              searchConfig: searchConfigSchema.validate({}),
              uiSettingsValidationsEnabled: false,
              elasticsearchTimeouts: { shardTimeout: 30000, requestTimeout: 30000 },
              rollupsEnabled: false,
            },
            docLinks: coreMock.createSetup().docLinks,
          },
          entityStoreRuntime: { maintainers: [] },
          agentBuilderRun: getAgentBuilderRunSettings({
            config: agentBuilderConfig.validate({}, { dev: false }),
            env: coreMock.createPluginInitializerContext().env,
            getSearchInferenceEndpoints: () => undefined,
          }),
        },
        seedContributions: { 'agent-builder': [security], 'workflow-steps': [contribution] },
        additionalContributions: {
          'agent-builder': [join(__dirname, '../agent_builder_contribution.ts')],
          'workflow-steps': [join(__dirname, 'fixtures/native_security_core_tools.ts')],
        },
        workflows: {
          security: { steps: [{ name: 'tools', type: 'test.security.core_tools', with: {} }] },
        },
        seed: async ({ es }) => {
          await es.indices.create({
            index: getLatestEntitiesIndexName('default'),
            aliases: { [getEntitiesAlias(ENTITY_LATEST, 'default')]: {} },
          });
          await es.index({
            index: getRiskIndex('default'),
            id: 'host-native',
            document: {
              host: {
                risk: {
                  calculated_score_norm: 78,
                  calculated_level: 'High',
                  id_value: 'native-host',
                  id_field: 'host.name',
                  notes: [],
                  '@timestamp': new Date().toISOString(),
                },
              },
            },
            refresh: 'wait_for',
          });
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('reads real risk scores and builds navigation through the native Agent Builder API', async () => {
      try {
        await harness.run('security');
      } catch (cause) {
        const { error, fatal, warn } = loggerMock.collect(logger);
        throw new Error(JSON.stringify({ error, fatal, warn }), { cause });
      }
      const [execution] = await harness.executionsOf('security');
      const [step] = await harness.stepsOf(execution.id);
      expect(step.error).toBeUndefined();
      expect(execution.status).toBe('completed');
      expect(step.output.output ?? step.output).toEqual({
        riskScores: [{ id_value: 'native-host', calculated_score_norm: 78 }],
        url: '/app/security/alerts',
        beforeConfirmation: true,
        ruleEnabled: false,
      });
      const stored = await harness.es.search({
        index: '.kibana',
        query: { term: { type: EntityResolutionRuleType.name } },
      });
      expect(stored.hits.hits).toHaveLength(1);
      expect(stored.hits.hits[0]._source).toMatchObject({
        [EntityResolutionRuleType.name]: { id: 'email_exact_match', enabled: false },
      });
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
