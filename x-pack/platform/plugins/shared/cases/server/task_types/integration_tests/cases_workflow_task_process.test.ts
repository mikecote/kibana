/**
 * @jest-environment node
 */

/* eslint-disable @kbn/eslint/require-license-header, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-explicit-any */
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import { KibanaFeature } from '@kbn/features-plugin/common';
import {
  ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
  getAlertingAuthorizationTaskProcessSettings,
} from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import { UnifiedAttachmentTypeRegistry } from '../../attachment_framework/unified_attachment_registry';
import { registerInternalAttachments } from '../../internal_attachments';
import { ConfigSchema } from '../../config';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import {
  CASE_ATTACHMENT_SAVED_OBJECT,
  CASE_SAVED_OBJECT,
  CASE_USER_ACTION_SAVED_OBJECT,
} from '../../../common/constants';
import type { CasesTaskProcessSettings } from '../cases_task_process_settings';
import { getCasesTaskProcessSavedObjectTypes } from '../cases_saved_object_types';

const CREATE_WORKFLOW_ID = 'create-case-workflow';
const DELETE_WORKFLOW_ID = 'delete-cases-workflow';
const ON_CREATED_WORKFLOW_ID = 'on-case-created-workflow';
const CASES_INDEX = '.kibana_alerting_cases';
const USAGE_COUNTERS_INDEX = '.kibana_usage_counters';
// How the saved object stores `critical`.
const SEVERITY_CRITICAL = 30;

const attachmentRegistry = new UnifiedAttachmentTypeRegistry();
registerInternalAttachments(attachmentRegistry);

const feature = new KibanaFeature({
  id: 'securitySolutionCasesV3',
  name: 'Security cases',
  app: [],
  category: DEFAULT_APP_CATEGORIES.management,
  cases: ['securitySolution'],
  privileges: {
    all: {
      savedObject: { all: [], read: [] },
      ui: [],
      cases: {
        create: ['securitySolution'],
        read: ['securitySolution'],
        update: ['securitySolution'],
        push: ['securitySolution'],
      },
    },
    read: { savedObject: { all: [], read: [] }, ui: [], cases: { read: ['securitySolution'] } },
  },
});
const alertsSnapshot = getAlertingAuthorizationTaskProcessSettings({
  ruleTypeRegistry: { list: () => new Map<string, never>() },
  features: { getKibanaFeatures: () => [feature] },
  spacesEnabled: true,
  securityEnabled: true,
});

const casesSettings: CasesTaskProcessSettings = {
  isCasesAttachmentsEnabled: true,
  isTemplatesEnabled: true,
  workflows: {
    config: {
      templates: { enabled: true },
      assigneeIdentity: { enabled: true },
      attachments: { enabled: true },
      analyticsV2: { enabled: false },
      files: ConfigSchema.validate({ files: { allowedMimeTypes: ['text/plain'], maxSize: 1024 } })
        .files,
    },
    spacesEnabled: true,
    attachmentTypeIds: attachmentRegistry.list().map(({ id }) => id),
    // What the features registry of Kibana has.
    featureCaseOwners: [{ id: 'securitySolutionCasesV3', cases: ['securitySolution'] }],
    isEmailServiceAvailable: false,
    hasAlertStatusChangedListeners: false,
    closeReasonOwners: [],
  },
};

/**
 * Runs `workflow:scheduled` workflows with cases steps from the real bundle in a real task process:
 * the steps come from the `workflow-steps` contribution of cases, build the cases client of Kibana
 * over the services of the process (privileges, space, saved objects) and write the case, its
 * attachment and its user actions. The events of the case reach the engine, which schedules the
 * workflow that listens to them. Case deletion removes its attachments and native file contents.
 */
describe.each(WORKFLOW_PROCESS_TEST_MODES)('Cases $mode/$reuse', ({ mode, reuse }) => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
      mode,
      reuse,
      additionalContributions: {
        'workflow-steps': [join(__dirname, 'fixtures/native_case_file_contribution.ts')],
      },
      workflows: {
        [CREATE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'create',
              type: 'cases.createCase',
              with: {
                title: 'Suspicious login',
                description: 'Several failed logins from one host',
                owner: 'securitySolution',
                tags: ['from-workflow'],
                severity: 'high',
              },
            },
            {
              name: 'comment',
              type: 'cases.addComment',
              with: {
                case_id: '{{ steps.create.output.case.id }}',
                comment: 'Opened by a workflow in a task process',
              },
            },
            {
              name: 'severity',
              type: 'cases.setSeverity',
              with: { case_id: '{{ steps.create.output.case.id }}', severity: 'critical' },
            },
            {
              name: 'read',
              type: 'cases.getCase',
              with: { case_id: '{{ steps.create.output.case.id }}' },
            },
          ],
        },
        [DELETE_WORKFLOW_ID]: {
          steps: [
            {
              name: 'create',
              type: 'cases.createCase',
              with: {
                title: 'Evidence to delete',
                description: 'Native file cleanup',
                owner: 'securitySolution',
              },
            },
            {
              name: 'attach',
              type: 'cases.addAttachments',
              with: {
                case_id: '{{ steps.create.output.case.id }}',
                attachments: [{ type: 'comment', data: { content: 'Evidence comment' } }],
              },
            },
            {
              name: 'removeAttachment',
              type: 'cases.deleteAttachments',
              with: {
                case_id: '{{ steps.create.output.case.id }}',
                ids: ['{{ steps.attach.output.case.comments[0].id }}'],
              },
            },
            {
              name: 'file',
              type: 'test.cases.storeFile',
              with: { case_id: '{{ steps.create.output.case.id }}' },
            },
            {
              name: 'delete',
              type: 'cases.deleteCases',
              with: { case_ids: ['{{ steps.create.output.case.id }}'] },
            },
          ],
        },
        // Scheduled by the event of the case the first workflow creates.
        [ON_CREATED_WORKFLOW_ID]: {
          triggers: [{ type: 'cases.caseCreated' }],
          steps: [{ name: 'log', type: 'console', with: { message: 'case created' } }],
        },
      },
      settings: {
        cases: casesSettings,
        [ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID]: alertsSnapshot,
      },
      // The usage counters index Kibana has: the process stores what the cases client counts.
      savedObjectTypes: [
        ...getCasesTaskProcessSavedObjectTypes(),
        {
          name: 'usage-counter',
          indexPattern: USAGE_COUNTERS_INDEX,
          mappings: {
            dynamic: false,
            properties: {
              domainId: { type: 'keyword' },
              counterName: { type: 'keyword' },
              counterType: { type: 'keyword' },
              source: { type: 'keyword' },
              count: { type: 'integer' },
            },
          },
        },
      ] as never,
      // What Kibana has: the default space.
      seed: async ({ es }) => {
        await es.index({
          index: '.kibana',
          id: 'space:default',
          refresh: true,
          document: {
            type: 'space',
            space: { name: 'Default', disabledFeatures: [] },
            updated_at: new Date().toISOString(),
          },
        });
      },
    });
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('creates, comments on, updates and reads a case in the process, and emits its events', async () => {
    const onDispatchFailure = jest.fn();
    await harness.run(CREATE_WORKFLOW_ID, onDispatchFailure);

    // Not declined: the step types are in the registry of the process.
    expect(onDispatchFailure).not.toHaveBeenCalled();

    const [execution] = await harness.executionsOf(CREATE_WORKFLOW_ID);
    const steps = await harness.stepsOf(execution.id);
    const byId = Object.fromEntries(steps.map((step) => [step.stepId, step]));
    expect(execution).toEqual(expect.objectContaining({ status: 'completed', spaceId: 'default' }));
    for (const name of ['create', 'comment', 'severity', 'read']) {
      expect(byId[name]).toEqual(expect.objectContaining({ status: 'completed' }));
    }
    const caseId = byId.create.output.case.id;
    expect(byId.create.output.case).toEqual(
      expect.objectContaining({ title: 'Suspicious login', owner: 'securitySolution' })
    );
    expect(byId.read.output.case).toEqual(
      expect.objectContaining({ id: caseId, severity: 'critical', totalComment: 1 })
    );

    // What the cases saved objects hold, as Kibana would have written them.
    await harness.es.indices.refresh({ index: CASES_INDEX });
    const found = async (type: string) =>
      (
        await harness.es.search<Record<string, any>>({
          index: CASES_INDEX,
          size: 100,
          query: { term: { type } },
        })
      ).hits.hits;
    const [caseDoc] = await found(CASE_SAVED_OBJECT);
    expect(caseDoc._id).toBe(`${CASE_SAVED_OBJECT}:${caseId}`);
    expect(caseDoc._source![CASE_SAVED_OBJECT]).toEqual(
      expect.objectContaining({
        title: 'Suspicious login',
        severity: SEVERITY_CRITICAL,
        tags: ['from-workflow'],
        owner: 'securitySolution',
      })
    );
    const attachments = await found(CASE_ATTACHMENT_SAVED_OBJECT);
    expect(attachments).toHaveLength(1);
    expect(JSON.stringify(attachments[0]._source)).toContain('Opened by a workflow');
    // Create, comment and severity change.
    expect((await found(CASE_USER_ACTION_SAVED_OBJECT)).length).toBeGreaterThanOrEqual(3);

    // The `caseCreated` event reached the engine: the workflow that listens to it was scheduled.
    const tasks = await harness.es.search<Record<string, any>>({
      index: '.kibana_task_manager',
      size: 100,
      query: { term: { 'task.taskType': 'workflow:run' } },
    });
    expect(JSON.stringify(tasks.hits.hits)).toContain(ON_CREATED_WORKFLOW_ID);

    // The cases client counted the call with the usage counter of its domain, and the process stored
    // it itself before it answered: Kibana got nothing back to apply.
    await harness.es.indices.refresh({ index: USAGE_COUNTERS_INDEX });
    const counters = await harness.es.search<{ 'usage-counter': Record<string, unknown> }>({
      index: USAGE_COUNTERS_INDEX,
      query: { term: { 'usage-counter.domainId': 'cases' } },
    });
    expect(counters.hits.hits.map((hit) => hit._source!['usage-counter'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domainId: 'cases',
          counterType: expect.stringMatching(/^cases_client\./),
          count: expect.any(Number),
        }),
      ])
    );
  });

  it('creates attachments and file contents, then deletes them with the case in the worker', async () => {
    const failure = jest.fn();
    await harness.run(DELETE_WORKFLOW_ID, failure);
    expect(failure).not.toHaveBeenCalled();
    const [execution] = await harness.executionsOf(DELETE_WORKFLOW_ID);
    expect(execution.status).toBe('completed');
    const steps = await harness.stepsOf(execution.id);
    expect(steps.map(({ stepId, status }) => ({ stepId, status }))).toEqual(
      expect.arrayContaining([
        { stepId: 'create', status: 'completed' },
        { stepId: 'attach', status: 'completed' },
        { stepId: 'removeAttachment', status: 'completed' },
        { stepId: 'file', status: 'completed' },
        { stepId: 'delete', status: 'completed' },
      ])
    );
    const created = steps.find(({ stepId }) => stepId === 'create');
    const storedFile = steps.find(({ stepId }) => stepId === 'file');
    expect(storedFile?.output.bytes).toBe(Buffer.byteLength('Evidence uploaded by the worker'));
    expect(storedFile?.output.chunks).toBeGreaterThan(0);
    const caseId = created?.output.case.id;
    if (typeof caseId !== 'string') throw new Error('The created case id was not persisted');
    expect(
      await harness.es.exists({ index: CASES_INDEX, id: `${CASE_SAVED_OBJECT}:${caseId}` })
    ).toBe(false);
    await harness.es.indices.refresh({ index: '.kibana' });
    const files = await harness.es.count({ index: '.kibana', query: { term: { type: 'file' } } });
    expect(files.count).toBe(0);
    const internalEs = harness.es.child({ headers: { 'x-elastic-product-origin': 'kibana' } });
    await internalEs.indices.refresh({ index: '.kibana_blob_storage' });
    expect((await internalEs.count({ index: '.kibana_blob_storage' })).count).toBe(0);
    expect(harness.kibanaRequests).toEqual([]);
  });
});
