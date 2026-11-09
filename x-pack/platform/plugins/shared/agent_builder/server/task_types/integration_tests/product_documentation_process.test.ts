/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { platformCoreTools } from '@kbn/agent-builder-common';
import { SavedObjectsClient } from '@kbn/core/server';
import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { DocumentationProduct, getProductDocIndexName } from '@kbn/product-doc-common';
import { config as productDocConfig } from '@kbn/product-doc-base-plugin/server/config';
import { ProductDocInstallClient } from '@kbn/product-doc-base-plugin/server/services/doc_install_status';
import { productDocReadSavedObjectTypes } from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import { kibanaPackageJson, REPO_ROOT } from '@kbn/repo-info';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { configSchema as agentBuilderConfigSchema } from '../../config';
import { collectRegisteredIds } from '../../run_services/collect_registered_ids';
import {
  AGENT_BUILDER_RUN_SETTINGS_ID,
  getAgentBuilderRunSettings,
} from '../../run_services/run_settings';
import { agentBuilderSpaceSettingsType } from '../../saved_objects';
import { getExampleContributionSettings } from '../example_contribution_settings';
import { call, startLlmStub } from './llm_stub';

const CONNECTOR_ID = 'documentation-model';
const INFERENCE_ID = 'native-elser-documentation';
const WORKFLOW_ID = 'native-documentation-retrieval';
const DOCUMENT_TITLE = 'Native workflow documentation';
const DOCUMENT_CONTENT = 'Native workflow semantic retrieval persists isolated execution records.';
const DOCUMENT_URL = 'https://www.elastic.co/guide/en/kibana/current/native-workflow-proof.html';

const { getContributionFiles } = jest.requireActual<{
  getContributionFiles: (key: string) => string[];
}>(join(REPO_ROOT, 'src/dev/task_bundles/build'));
const getContributions = <T extends object>(key: string): T[] =>
  getContributionFiles(key).map(
    (file) => jest.requireActual<{ contribution: T }>(file).contribution
  );

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native documentation retrieval in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let llm: Awaited<ReturnType<typeof startLlmStub>>;
    let embeddings: ReturnType<typeof createServer>;
    let embeddingCalls = 0;

    beforeAll(async () => {
      llm = await startLlmStub();
      embeddings = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          const { inputs } = JSON.parse(body) as { inputs: string | string[] };
          embeddingCalls++;
          const texts = Array.isArray(inputs) ? inputs : [inputs];
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(texts.map(() => [0.2, 0.4, 0.6])));
        });
      });
      await new Promise<void>((resolve) => embeddings.listen(0, '127.0.0.1', resolve));
      const { port } = embeddings.address() as AddressInfo;
      const contributions = getContributions<AgentBuilderContribution>('agent-builder');
      const { env } = coreMock.createPluginInitializerContext();
      const { artifactRepositoryUrl, artifactRepositoryProxyUrl, elserInferenceId } =
        productDocConfig.schema.validate({ autoInstallEnabled: false });
      const settings = {
        ...getExampleContributionSettings(contributions),
        agentBuilderPlatform: { llmTasks: true },
        productDocRead: { artifactRepositoryUrl, artifactRepositoryProxyUrl, elserInferenceId },
        [AGENT_BUILDER_RUN_SETTINGS_ID]: getAgentBuilderRunSettings({
          config: agentBuilderConfigSchema.validate({}, { dev: false }),
          env: {
            ...env,
            packageInfo: { ...env.packageInfo, version: kibanaPackageJson.version },
          },
          getSearchInferenceEndpoints: () => undefined,
        }),
      };
      const registered = await collectRegisteredIds({
        contributions,
        settings,
        logger: loggingSystemMock.createLogger(),
      });
      expect(registered.tools).toContain(platformCoreTools.productDocumentation);
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings,
        seedContributions: {
          'agent-builder': contributions,
          embeddables: getContributions('embeddables'),
          'lens-visualization-migrations': getContributions('lens-visualization-migrations'),
        },
        parity: Object.entries(registered).map(([kind, ids]) => ({
          kind: `agentBuilder.${kind}`,
          ids,
        })),
        savedObjectTypes: [agentBuilderSpaceSettingsType],
        workflows: {
          [WORKFLOW_ID]: {
            steps: [
              {
                name: 'documentation',
                type: 'ai.agent',
                'connector-id': CONNECTOR_ID,
                with: {
                  message: call(platformCoreTools.productDocumentation, {
                    query: 'Native workflow semantic retrieval',
                    product: 'kibana',
                    max: 1,
                  }),
                },
              },
            ],
          },
        },
        seed: async ({ es, host }) => {
          // Native documentation clients share legacy ELSER aliases in one installation namespace.
          const inferenceId = INFERENCE_ID;
          await es.inference.put({
            inference_id: inferenceId,
            task_type: 'text_embedding',
            inference_config: {
              service: 'hugging_face',
              service_settings: {
                api_key: 'native-test-key',
                url: `http://127.0.0.1:${port}/embeddings`,
              },
            },
          });
          const install = new ProductDocInstallClient({
            soClient: new SavedObjectsClient(
              host.savedObjects.createInternalRepository(
                productDocReadSavedObjectTypes.map(({ name }) => name)
              )
            ),
            log: host.logger,
          });
          for (const productName of Object.values(DocumentationProduct)) {
            const index = getProductDocIndexName(productName, inferenceId);
            await es.indices.create({
              index,
              mappings: {
                properties: {
                  content_title: { type: 'text' },
                  content_body: { type: 'semantic_text', inference_id: inferenceId },
                  ai_summary: { type: 'semantic_text', inference_id: inferenceId },
                  ai_questions_answered: { type: 'semantic_text', inference_id: inferenceId },
                  product_name: { type: 'keyword' },
                  url: { type: 'keyword' },
                },
              },
            });
            await install.setInstallationStarted({
              productName,
              productVersion: kibanaPackageJson.version.split('.').slice(0, 2).join('.'),
              inferenceId,
            });
            await install.setInstallationSuccessful(productName, index, inferenceId);
          }
          await es.index({
            index: getProductDocIndexName(DocumentationProduct.kibana, inferenceId),
            refresh: true,
            document: {
              content_title: DOCUMENT_TITLE,
              content_body: DOCUMENT_CONTENT,
              ai_summary: DOCUMENT_CONTENT,
              ai_questions_answered: 'How does native workflow semantic retrieval work?',
              product_name: DocumentationProduct.kibana,
              url: DOCUMENT_URL,
            },
          });
          await host.savedObjects
            .getUnsafeInternalClient()
            .create(
              'config',
              { 'agentBuilder:experimentalFeatures': true, buildNum: 1 },
              { id: kibanaPackageJson.version, overwrite: true }
            );
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: ['action'] })
            .create(
              'action',
              {
                name: 'documentation model',
                actionTypeId: '.gen-ai',
                isMissingSecrets: false,
                config: {
                  apiProvider: 'OpenAI',
                  apiUrl: `${llm.url}/v1/chat/completions`,
                  defaultModel: 'gpt-4',
                },
                secrets: { apiKey: 'native-test-key' },
              },
              { id: CONNECTOR_ID }
            );
        },
      });
    });

    afterAll(async () => {
      await harness?.stop();
      await llm?.stop();
      if (embeddings) {
        await new Promise<void>((resolve, reject) =>
          embeddings.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });

    it('returns indexed semantic documentation through the real platform tool and native SDKs', async () => {
      const before = embeddingCalls;
      const dispatchFailure = jest.fn();
      await harness.run(WORKFLOW_ID, dispatchFailure);
      expect(dispatchFailure).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf(WORKFLOW_ID);
      expect(execution.status).toBe('completed');
      const results = llm.toolResultsSince(0);
      expect(results).toContain(DOCUMENT_TITLE);
      expect(results).toContain(DOCUMENT_CONTENT);
      expect(results).toContain(DOCUMENT_URL);
      expect(embeddingCalls).toBeGreaterThan(before);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
