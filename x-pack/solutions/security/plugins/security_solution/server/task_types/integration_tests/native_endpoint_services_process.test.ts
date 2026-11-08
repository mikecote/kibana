/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import { coreMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { searchConfigSchema } from '@kbn/data-plugin/server/config';
import { config as fleetConfig } from '@kbn/fleet-plugin/server/config';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { createMockConfig } from '../../config.mock';
import { SECURITY_AGENT_BUILDER_SETTINGS_ID } from '../agent_builder_settings';
import type { SecurityAgentBuilderSettings } from '../agent_builder_settings';
import { contribution } from './fixtures/native_endpoint_services';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Endpoint workflow services in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    const logger = loggerMock.create();
    const snapshot: SecurityAgentBuilderSettings = {
      config: createMockConfig(),
      productFeatures: {
        enabledProductFeatureKeys: [ProductFeatureKey.graphVisualization],
        registeredActions: [],
      },
      cloud: { isCloudEnabled: true, isServerlessEnabled: false },
      telemetryOptIn: true,
      isServerless: false,
      canEncrypt: true,
      cpsAvailable: false,
      plugins: { ml: false, security: true, osquery: false },
    };
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger,
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
        },
        seedContributions: { 'workflow-steps': [contribution] },
        additionalContributions: {
          'workflow-steps': [join(__dirname, 'fixtures/native_endpoint_services.ts')],
        },
        workflows: {
          endpoint: { steps: [{ name: 'read', type: 'test.security.native_endpoint', with: {} }] },
        },
        seed: async ({ es }) => {
          await es.index({
            index: 'native-endpoint-docs',
            id: 'native',
            document: { host: { name: 'native-endpoint' } },
            refresh: 'wait_for',
          });
        },
      });
    });
    afterAll(async () => harness?.stop());

    it('executes native scoped searches and Fleet authorization with current dispatch gates', async () => {
      const seen = new Set<string>();
      for (const enabled of [true, true, false, false, true, true]) {
        snapshot.telemetryOptIn = enabled;
        snapshot.productFeatures.enabledProductFeatureKeys = enabled
          ? [ProductFeatureKey.graphVisualization]
          : [];
        try {
          await harness.run('endpoint');
        } catch (cause) {
          const { error, fatal, warn } = loggerMock.collect(logger);
          throw new Error(JSON.stringify({ error, fatal, warn }), { cause });
        }
        const execution = (await harness.executionsOf('endpoint')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('The native Endpoint workflow did not execute');
        seen.add(execution.id);
        const [step] = await harness.stepsOf(execution.id);
        expect(step.error).toBeUndefined();
        expect(execution.status).toBe('completed');
        expect(step.output.output ?? step.output).toEqual({
          found: 1,
          graphEnabled: enabled,
          optedIn: enabled,
          fleetRead: true,
          spaceId: 'default',
        });
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 3 : 6);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
