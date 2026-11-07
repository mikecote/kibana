/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  WorkflowsManagementApiActions,
  WorkflowsManagementOperationPrivileges,
} from '@kbn/workflows';
import { contribution as spacesContribution } from '@kbn/workflows-extensions/server/spaces_runtime_contribution';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import { WORKFLOWS_EXECUTIONS_INDEX } from '@kbn/workflows-execution-engine/server/repositories/data_access_layer';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import { extendWorkflowTestMappings } from './fixtures/workflow_test_mappings';

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native triage execution reads in $mode (reuse: $reuse)',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    let readerKey: string;
    let unmanagedReaderKey: string;
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        savedObjectTypes: spacesContribution.declares?.savedObjectTypes,
        seedContributions: { 'workflow-steps': [spacesContribution] },
        workflows: {
          'foreign-batch': {
            steps: [{ name: 'done', type: 'console', with: { message: 'Foreign batch' } }],
          },
          'foreign-headroom': {
            steps: [
              {
                name: 'headroom',
                type: 'alertzero.triage.headroom',
                with: { batch_workflow_id: 'foreign-batch' },
              },
            ],
          },
          batch: { steps: [{ name: 'done', type: 'console', with: { message: 'Native batch' } }] },
          headroom: {
            steps: [
              {
                name: 'headroom',
                type: 'alertzero.triage.headroom',
                with: { batch_workflow_id: 'batch' },
              },
            ],
          },
        },
        settings: {
          alertzero: {
            serviceAccountsEnabled: true,
            managedWorkflowsReady: true,
            searchInferenceEndpointsAvailable: false,
            actionsServiceAvailable: true,
            huntServicesReady: true,
            fleetAgentServiceAvailable: false,
            telemetryOptedIn: false,
          },
          workflowsManagementRuntime: { available: true, managedWorkflowPluginIds: ['alertzero'] },
        },
        seed: async ({ es, host }) => {
          await extendWorkflowTestMappings(es);
          await host.savedObjects
            .getUnsafeInternalClient({ includedHiddenTypes: ['space'] })
            .create(
              'space',
              { name: 'Foreign space', disabledFeatures: [] },
              { id: 'foreign-space' }
            );
          for (const id of ['foreign-batch', 'foreign-headroom']) {
            await es.update({
              index: WORKFLOW_INDEX_NAME,
              id,
              refresh: 'wait_for',
              doc: { spaceId: 'foreign-space' },
            });
          }
          await es.update({
            index: WORKFLOW_INDEX_NAME,
            id: 'batch',
            refresh: 'wait_for',
            doc: { managed: true, managedBy: 'alertzero' },
          });
          const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
          if (!security) throw new Error('Native execution proof requires Security');
          for (const [privilege, managed] of [
            ['native_execution_reader', true],
            ['native_unmanaged_execution_reader', false],
          ] as const) {
            await es.security.putPrivileges({
              body: {
                'kibana-.kibana': {
                  [privilege]: {
                    application: 'kibana-.kibana',
                    name: privilege,
                    actions: [
                      security.authz.actions.login,
                      security.authz.actions.savedObject.get('*', '*'),
                      ...WorkflowsManagementOperationPrivileges.readExecution.map((action) =>
                        security.authz.actions.api.get(action)
                      ),
                      ...(managed
                        ? [
                            security.authz.actions.api.get(
                              WorkflowsManagementApiActions.readManagedExecution
                            ),
                          ]
                        : []),
                    ],
                  },
                },
              },
            });
            const key = await es.security.createApiKey({
              name: privilege,
              role_descriptors: {
                native: {
                  cluster: [],
                  indices: [{ names: ['.*'], privileges: ['all'], allow_restricted_indices: true }],
                  applications: [
                    { application: 'kibana-.kibana', privileges: [privilege], resources: ['*'] },
                  ],
                },
              },
            });
            if (managed) readerKey = key.encoded;
            else unmanagedReaderKey = key.encoded;
          }
        },
      });
    }, 300000);
    afterAll(async () => harness?.stop());
    it('rechecks managed-read privileges and private ACLs and counts only current live batches in the workflow space', async () => {
      const failure = jest.fn();
      await harness.run('batch', failure);
      const [batch] = await harness.executionsOf('batch');
      expect(batch).toMatchObject({ status: 'completed' });
      for (const [id, status, spaceId] of [
        ['live-running', 'running', 'default'],
        ['live-queued', 'queued', 'default'],
        ['foreign-running', 'running', 'foreign-space'],
      ]) {
        await harness.es.index({
          index: WORKFLOWS_EXECUTIONS_INDEX,
          id,
          refresh: 'wait_for',
          document: { ...batch, id, status, spaceId, finishedAt: undefined },
        });
      }
      const seen = new Set<string>();
      const read = async (apiKey: string, inFlight: number) => {
        await harness.run('headroom', failure, { apiKey });
        const execution = (await harness.executionsOf('headroom')).find(({ id }) => !seen.has(id));
        if (!execution) throw new Error('No native headroom execution was persisted');
        seen.add(execution.id);
        expect({ status: execution.status, error: execution.error }).toEqual({
          status: 'completed',
          error: undefined,
        });
        const [step] = await harness.stepsOf(execution.id);
        expect(step.output).toMatchObject({
          status: 'ok',
          in_flight: inFlight,
          slots: 40 - inFlight,
        });
      };
      await read(harness.apiKey, 2);
      await read(unmanagedReaderKey, 20);
      await read(readerKey, 2);
      await harness.es.update({
        index: WORKFLOW_INDEX_NAME,
        id: 'batch',
        refresh: 'wait_for',
        doc: {
          owner_id: 'another-profile',
          access_control: { access_mode: 'private', entries: [] },
        },
      });
      await read(readerKey, 0);
      await read(harness.apiKey, 2);
      await harness.es.update({
        index: WORKFLOWS_EXECUTIONS_INDEX,
        id: 'live-queued',
        refresh: 'wait_for',
        doc: { status: 'completed' },
      });
      await read(harness.apiKey, 1);
      await harness.es.index({
        index: WORKFLOWS_EXECUTIONS_INDEX,
        id: 'foreign-batch-live',
        refresh: 'wait_for',
        document: {
          ...batch,
          id: 'foreign-batch-live',
          workflowId: 'foreign-batch',
          spaceId: 'foreign-space',
          status: 'running',
          finishedAt: undefined,
        },
      });
      await harness.runTask(
        'workflow:scheduled',
        {
          id: 'workflow:foreign-headroom:scheduled',
          params: {
            workflowId: 'foreign-headroom',
            spaceId: 'foreign-space',
            triggerType: 'scheduled',
          },
        },
        failure,
        { apiKey: harness.apiKey, spaceId: 'foreign-space' }
      );
      const [foreignExecution] = await harness.executionsOf('foreign-headroom');
      expect(foreignExecution).toMatchObject({ status: 'completed', spaceId: 'foreign-space' });
      const [foreignStep] = await harness.stepsOf(foreignExecution.id);
      expect(foreignStep.output).toMatchObject({ status: 'ok', in_flight: 1, slots: 39 });
      expect(harness.getWorkerStats().spawned).toBe(reuse ? 1 : 8);
      expect(harness.kibanaRequests).toEqual([]);
      expect(failure).not.toHaveBeenCalled();
    }, 240000);
  }
);
