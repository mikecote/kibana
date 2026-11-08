/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SavedObjectsClient } from '@kbn/core/server';
import {
  PRODUCT_DOC_READ_SETTINGS_ID,
  productDocReadSavedObjectTypes,
} from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import { ProductDocInstallClient } from '@kbn/product-doc-base-plugin/server/services/doc_install_status';
import { INSTALL_ALL_TASK_TYPE } from '@kbn/product-doc-base-plugin/server/tasks/install_all';
import { getInferenceScope } from '@kbn/product-doc-base-plugin/server/tasks/utils';
import { DocumentationProduct, getSecurityLabsArtifactName } from '@kbn/product-doc-common';
import { TaskStatus } from '@kbn/task-manager-plugin/server';
import { contribution } from './__fixtures__/native_product_doc_status';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from './workflow_process_harness';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native documentation in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let repository: string;
    const latestVersion = '2026.11.01';
    beforeAll(async () => {
      repository = await mkdtemp(join(tmpdir(), 'native-doc-repository-'));
      const artifact = getSecurityLabsArtifactName({
        version: latestVersion,
        inferenceId: 'installed',
      });
      await writeFile(
        join(repository, 'index.xml'),
        `<ListBucketResult><Contents><Key>${artifact}</Key></Contents></ListBucketResult>`
      );
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        settings: {
          [PRODUCT_DOC_READ_SETTINGS_ID]: {
            artifactRepositoryUrl: pathToFileURL(repository).href,
            elserInferenceId: 'installed',
          },
        },
        additionalContributions: {
          'workflow-steps': [join(__dirname, '__fixtures__/native_product_doc_status.ts')],
        },
        seedContributions: { 'workflow-steps': [contribution] },
        savedObjectTypes: productDocReadSavedObjectTypes,
        registerTaskSchedulingDefinitions: (definitions) =>
          definitions.registerTaskDefinitions({
            [INSTALL_ALL_TASK_TYPE]: {
              title: 'Install documentation',
            },
          }),
        workflows: Object.fromEntries(
          ['pending', 'failed', 'installed'].map((inferenceId) => [
            inferenceId,
            {
              steps: [
                { name: 'read_status', type: 'test.sdk.product_doc_status', with: { inferenceId } },
              ],
            },
          ])
        ),
        seed: async ({ host }) => {
          const client = new ProductDocInstallClient({
            soClient: new SavedObjectsClient(
              host.savedObjects.createInternalRepository(
                productDocReadSavedObjectTypes.map(({ name }) => name)
              )
            ),
            log: host.logger,
          });
          for (const inferenceId of ['pending', 'failed', 'installed']) {
            for (const productName of Object.values(DocumentationProduct)) {
              await client.setInstallationStarted({
                productName,
                productVersion: '9.6',
                inferenceId,
              });
              await client.setInstallationSuccessful(
                productName,
                `native-doc-${productName}`,
                inferenceId
              );
            }
          }
          await client.setSecurityLabsInstallationStarted({
            inferenceId: 'installed',
            version: '2026.10.01',
          });
          await client.setSecurityLabsInstallationSuccessful({
            inferenceId: 'installed',
            version: '2026.10.01',
            indexName: 'native-security-labs',
          });
          if (!host.taskManager) throw new Error('The native task scheduling SDK is missing');
          const tasks = host.savedObjects.createInternalRepository(['task']);
          for (const inferenceId of ['pending', 'failed']) {
            const task = await host.taskManager.schedule({
              taskType: INSTALL_ALL_TASK_TYPE,
              scope: [getInferenceScope(inferenceId)],
              params: { inferenceId },
              state: {},
            });
            await tasks.update('task', task.id, {
              status: inferenceId === 'pending' ? TaskStatus.Running : TaskStatus.Failed,
            });
          }
        },
      });
    });
    afterAll(async () => {
      await harness?.stop();
      if (repository) await rm(repository, { recursive: true, force: true });
    });

    it('uses live task state and the configured Security Labs artifact repository', async () => {
      for (const [id, documentation] of [
        ['pending', 'installing'],
        ['failed', 'error'],
        ['installed', 'installed'],
      ]) {
        await harness.run(id);
        const [execution] = await harness.executionsOf(id);
        expect(execution.status).toBe('completed');
        const [step] = await harness.stepsOf(execution.id);
        expect(step.output.output ?? step.output).toEqual(
          id === 'installed'
            ? {
                documentation,
                labs: 'installed',
                latestVersion,
                isUpdateAvailable: true,
              }
            : { documentation, labs: 'uninstalled' }
        );
      }
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 3);
      expect(harness.kibanaRequests).toEqual([]);
    });
  }
);
