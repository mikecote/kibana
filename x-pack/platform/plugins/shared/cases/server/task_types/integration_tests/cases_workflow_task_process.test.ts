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

import { startWorkflowProcessHarness } from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
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

const casesSettings: CasesTaskProcessSettings = {
  isCasesAttachmentsEnabled: true,
  isTemplatesEnabled: true,
  workflows: {
    config: {
      templates: { enabled: true },
      assigneeIdentity: { enabled: true },
      attachments: { enabled: true },
      analyticsV2: { enabled: false },
    },
    spacesEnabled: true,
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
 * workflow that listens to them. A workflow that deletes cases is declined.
 */
describe('cases workflow steps served from the workflow:scheduled bundle', () => {
  let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;

  beforeAll(async () => {
    harness = await startWorkflowProcessHarness({
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
          steps: [{ name: 'delete', type: 'cases.deleteCases', with: { case_ids: ['case-1'] } }],
        },
        // Scheduled by the event of the case the first workflow creates.
        [ON_CREATED_WORKFLOW_ID]: {
          triggers: [{ type: 'cases.caseCreated' }],
          steps: [{ name: 'log', type: 'console', with: { message: 'case created' } }],
        },
      },
      settings: { cases: casesSettings },
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

  it('declines a workflow that deletes cases, writing nothing', async () => {
    const onDispatchFailure = jest.fn();
    await expect(harness.run(DELETE_WORKFLOW_ID, onDispatchFailure)).rejects.toThrow('422');

    expect(onDispatchFailure).toHaveBeenCalledTimes(1);
    expect(await harness.executionsOf(DELETE_WORKFLOW_ID)).toHaveLength(0);
  });
});
