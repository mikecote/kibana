/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import { ALERTING_CASES_SAVED_OBJECT_INDEX } from '@kbn/core-saved-objects-server';
import { KibanaFeature } from '@kbn/features-plugin/common';
import { loggerMock } from '@kbn/logging-mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { ActionTypeRegistry } from '@kbn/actions-plugin/server/action_type_registry';
import { actionsConfigMock } from '@kbn/actions-plugin/server/actions_config.mock';
import { licenseStateMock } from '@kbn/actions-plugin/server/lib/license_state.mock';
import { licensingMock } from '@kbn/licensing-plugin/server/mocks';
import { getConnectorType as getEmailConnectorType } from '@kbn/stack-connectors-plugin/server/connector_types/email';
import { registerUsageCountersSavedObjectTypes } from '@kbn/usage-collection-plugin/server/usage_counters/saved_objects';
import { z } from '@kbn/zod/v4';
import { kibanaPackageJson } from '@kbn/repo-info';
import { WORKFLOW_INDEX_NAME } from '@kbn/workflows/server/constants';
import type { ActionsTaskProcessSettings } from '@kbn/actions-plugin/server/task_types/task_process_settings';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '@kbn/workflows-execution-engine/server/integration_tests/workflow_process_harness';
import {
  getAlertingAuthorizationTaskProcessSettings,
  ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import { UnifiedAttachmentTypeRegistry } from '@kbn/cases-plugin/server/attachment_framework/unified_attachment_registry';
import { registerInternalAttachments } from '@kbn/cases-plugin/server/internal_attachments';
import { ConfigSchema } from '@kbn/cases-plugin/server/config';
import { getCasesTaskProcessSavedObjectTypes } from '@kbn/cases-plugin/server/task_types/cases_saved_object_types';
import type { CasesTaskProcessSettings } from '@kbn/cases-plugin/server/task_types/cases_task_process_settings';
import { DEFAULT_DETECTIONS_CLOSE_REASONS_KEY } from '../../../common/constants';
import { AlertStatusChangedTriggerId } from '../../../common/workflows/triggers';
import { registerCaseAttachments } from '../../cases/attachments/register';
import { securityAlertAttachmentType } from '../../cases/attachments/alert';
import { SECURITY_ALERTS_SETTINGS_ID } from '../security_alerts_settings';
import { SECURITY_CASE_ATTACHMENTS_SETTINGS_ID } from '../case_attachment_type_contribution';

const alertIndex = '.alerts-security.alerts-default';
const savedObjectTypes = getCasesTaskProcessSavedObjectTypes();
registerUsageCountersSavedObjectTypes({ registerType: (type) => savedObjectTypes.push(type) });
const feature = new KibanaFeature({
  id: 'securitySolution',
  name: 'Security',
  app: [],
  category: DEFAULT_APP_CATEGORIES.security,
  cases: ['securitySolution'],
  alerting: [{ ruleTypeId: 'siem.queryRule', consumers: ['siem'] }],
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
const attachmentRegistry = new UnifiedAttachmentTypeRegistry();
registerInternalAttachments(attachmentRegistry);
registerCaseAttachments(
  { registerAttachment: (definition) => attachmentRegistry.register(definition) },
  { entityAttachmentsEnabled: true, attackAttachmentsEnabled: true },
  {
    logger: loggerMock.create(),
    getScopedElasticsearchClient: async () => {
      throw new Error('Registration must not access Elasticsearch');
    },
  }
);
attachmentRegistry.register(securityAlertAttachmentType);
const settings: CasesTaskProcessSettings = {
  isCasesAttachmentsEnabled: true,
  isTemplatesEnabled: true,
  workflows: {
    config: ConfigSchema.validate({}),
    spacesEnabled: true,
    attachmentTypeIds: attachmentRegistry.list().map(({ id }) => id),
    featureCaseOwners: [{ id: feature.id, cases: ['securitySolution'] }],
    isEmailServiceAvailable: true,
    emailConnectorId: 'native-case-email',
    hasAlertStatusChangedListeners: true,
    closeReasonOwners: ['securitySolution'],
  },
};
const alertsSnapshot = getAlertingAuthorizationTaskProcessSettings({
  ruleTypeRegistry: {
    list: () =>
      new Map([
        [
          'siem.queryRule',
          { id: 'siem.queryRule', alerts: { context: 'security', isSpaceAware: true } },
        ],
      ]),
  },
  features: { getKibanaFeatures: () => [feature] },
  spacesEnabled: true,
  securityEnabled: true,
});
const createCaseStep = {
  name: 'create',
  type: 'cases.createCase',
  with: {
    title: 'Native Security case',
    description: 'Native solution services',
    owner: 'securitySolution',
  },
};
const updateCase = (closeReason: string) => ({
  name: 'close',
  type: 'cases.updateCase',
  with: {
    case_id: '{{ steps.create.output.case.id }}',
    updates: { status: 'closed', closeReason },
  },
});
const caseOutput = z.object({
  case: z.object({
    id: z.string(),
    status: z.string(),
    close_reason: z.string().nullable().optional(),
  }),
});

describe.each(WORKFLOW_PROCESS_TEST_MODES)(
  'Native Security Cases in $mode/$reuse',
  ({ mode, reuse }) => {
    let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
    const logger = loggingSystemMock.createLogger();
    beforeAll(async () => {
      harness = await startWorkflowProcessHarness({
        mode,
        reuse,
        logger,
        registerTaskSchedulingDefinitions: (taskDefinitionRegistry) => {
          const registry = new ActionTypeRegistry({
            taskDefinitionRegistry,
            licensing: licensingMock.createSetup(),
            actionsConfigUtils: actionsConfigMock.create(),
            licenseState: licenseStateMock.create(),
            inMemoryConnectors: [],
          });
          registry.register(getEmailConnectorType({}));
        },
        settings: {
          cases: settings,
          actionsConnectors: {
            inMemoryConnectors: [
              {
                id: 'native-case-email',
                name: 'Native Cases email',
                actionTypeId: '.email',
                isPreconfigured: true,
                isDeprecated: false,
                isSystemAction: false,
                isConnectorTypeDeprecated: false,
                config: {
                  from: 'cases@example.test',
                  service: 'other',
                  host: 'localhost',
                  port: 2525,
                  secure: false,
                  hasAuth: false,
                },
                secrets: {},
              },
            ],
          } satisfies ActionsTaskProcessSettings,
          [ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID]: alertsSnapshot,
          [SECURITY_CASE_ATTACHMENTS_SETTINGS_ID]: {
            entityAttachmentsEnabled: true,
            attackAttachmentsEnabled: true,
          },
          [SECURITY_ALERTS_SETTINGS_ID]: {
            searchIndexName: '.alerts-security.alerts',
            signalsIndex: '.siem-signals',
            appClientInitialized: true,
            kibanaBranch: 'main',
            buildFlavor: 'traditional',
            workflowEventsAvailable: true,
          },
        },
        savedObjectTypes,
        workflows: {
          'native-case': {
            steps: [
              createCaseStep,
              {
                name: 'alerts',
                type: 'cases.addAlerts',
                with: {
                  case_id: '{{ steps.create.output.case.id }}',
                  alerts: [
                    {
                      alertId: 'native-alert',
                      index: alertIndex,
                      rule: { id: 'native-rule', name: 'Native rule' },
                    },
                  ],
                },
              },
              {
                name: 'events',
                type: 'cases.addEvents',
                with: {
                  case_id: '{{ steps.create.output.case.id }}',
                  events: [{ eventId: 'native-event', index: 'native-case-events' }],
                },
              },
              updateCase('custom_reason'),
            ],
          },
          'assigned-case': { steps: [createCaseStep] },
          'invalid-close': { steps: [createCaseStep, updateCase('invalid_reason')] },
          'on-alert-status': {
            triggers: [{ type: AlertStatusChangedTriggerId }],
            steps: [
              { name: 'log', type: 'console', with: { message: 'Native Cases Security event' } },
            ],
          },
        },
        seed: async ({ es }) => {
          await es.security.putUser({
            username: 'native_case_assignee',
            password: 'native-case-password',
            roles: ['superuser'],
            email: 'assignee@example.test',
          });
          const profile = await es.security.activateUserProfile({
            grant_type: 'password',
            username: 'native_case_assignee',
            password: 'native-case-password',
          });
          await es.update({
            index: WORKFLOW_INDEX_NAME,
            id: 'assigned-case',
            refresh: true,
            doc: {
              definition: {
                steps: [
                  {
                    ...createCaseStep,
                    with: { ...createCaseStep.with, assignees: [{ uid: profile.uid }] },
                  },
                ],
              },
            },
          });
          await es.index({
            index: '.kibana',
            id: 'space:default',
            refresh: true,
            document: { type: 'space', space: { name: 'Default', disabledFeatures: [] } },
          });
          await es.index({
            index: '.kibana',
            id: `config:${kibanaPackageJson.version}`,
            refresh: true,
            document: {
              type: 'config',
              config: { [DEFAULT_DETECTIONS_CLOSE_REASONS_KEY]: ['custom_reason'] },
            },
          });
          await es.indices.create({
            index: alertIndex,
            mappings: {
              properties: {
                '@timestamp': { type: 'date' },
                'kibana.alert.workflow_status': { type: 'keyword' },
                'kibana.alert.rule.rule_type_id': { type: 'keyword' },
                'kibana.alert.rule.consumer': { type: 'keyword' },
                'kibana.alert.rule.producer': { type: 'keyword' },
                'kibana.space_ids': { type: 'keyword' },
              },
            },
          });
          await es.index({
            index: alertIndex,
            id: 'native-alert',
            refresh: true,
            document: {
              '@timestamp': new Date().toISOString(),
              'kibana.alert.uuid': 'native-alert',
              'kibana.alert.rule.rule_type_id': 'siem.queryRule',
              'kibana.alert.rule.consumer': 'siem',
              'kibana.alert.rule.producer': 'siem',
              'kibana.alert.rule.uuid': 'native-rule',
              'kibana.alert.status': 'active',
              'kibana.alert.workflow_status': 'open',
              'kibana.space_ids': ['default'],
            },
          });
          await es.index({
            index: 'native-case-events',
            id: 'native-event',
            refresh: true,
            document: { '@timestamp': new Date().toISOString(), message: 'Native event' },
          });
        },
      });
    });
    afterAll(async () => {
      await harness?.stop();
    });

    it('attaches native alerts and events, validates scoped close reasons and schedules the Security status workflow', async () => {
      const failed = jest.fn();
      await harness.run('native-case', failed);
      expect(failed).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf('native-case');
      expect(execution.status).toBe('completed');
      const steps = await harness.stepsOf(execution.id);
      expect(steps).toHaveLength(4);
      for (const step of steps) expect(step.status).toBe('completed');
      const close = steps.find(({ stepId }) => stepId === 'close');
      expect(caseOutput.parse(close?.output).case).toEqual(
        expect.objectContaining({ status: 'closed' })
      );
      const alert = await harness.es.get<{
        'kibana.alert.workflow_status': string;
        'kibana.alert.workflow_reason': string;
      }>({
        index: alertIndex,
        id: 'native-alert',
      });
      expect(alert._source?.['kibana.alert.workflow_status']).toBe('closed');
      expect(alert._source?.['kibana.alert.workflow_reason']).toBe('custom_reason');
      await harness.es.indices.refresh({ index: '.kibana_task_manager' });
      const tasks = await harness.es.search({
        index: '.kibana_task_manager',
        query: { term: { 'task.taskType': 'workflow:run' } },
      });
      expect(JSON.stringify(tasks.hits.hits)).toContain('on-alert-status');
      expect(harness.kibanaRequests).toEqual([]);
    });

    it('schedules a native email action for an assigned Elasticsearch user profile', async () => {
      const failed = jest.fn();
      await harness.run('assigned-case', failed);
      expect(failed).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf('assigned-case');
      expect(execution.status).toBe('completed');
      await harness.es.indices.refresh({ index: '.kibana_task_manager' });
      const tasks = await harness.es.search({
        index: '.kibana_task_manager',
        size: 100,
        query: { prefix: { 'task.taskType': 'actions:' } },
      });
      expect(
        logger.warn.mock.calls.filter(([message]) =>
          String(message).includes('Error notifying assignees')
        )
      ).toEqual([]);
      expect(tasks.hits.hits).toHaveLength(1);
      const queuedTask = z
        .object({
          task: z.object({
            taskType: z.literal('actions:.email'),
            params: z
              .string()
              .transform((value) =>
                z.object({ actionTaskParamsId: z.string() }).parse(JSON.parse(value))
              ),
          }),
        })
        .parse(tasks.hits.hits[0]._source);
      const queued = await harness.es.get<{
        action_task_params: { actionId: string; params: { to: string[]; messageHTML: string } };
      }>({
        index: ALERTING_CASES_SAVED_OBJECT_INDEX,
        id: `action_task_params:${queuedTask.task.params.actionTaskParamsId}`,
      });
      expect(queued._source?.action_task_params.actionId).toBe('native-case-email');
      expect(queued._source?.action_task_params.params.to).toEqual(['assignee@example.test']);
      expect(queued._source?.action_task_params.params.messageHTML).toContain(
        'Native Security case'
      );
      expect(harness.kibanaRequests).toEqual([]);
    });

    it('rejects an invalid close reason using the native solution validator', async () => {
      const failed = jest.fn();
      await harness.run('invalid-close', failed);
      expect(failed).not.toHaveBeenCalled();
      const [execution] = await harness.executionsOf('invalid-close');
      expect(execution.status).toBe('failed');
      const steps = await harness.stepsOf(execution.id);
      const create = steps.find(({ stepId }) => stepId === 'create');
      expect(create?.status).toBe('completed');
      const close = steps.find(({ stepId }) => stepId === 'close');
      expect(close?.status).toBe('failed');
      expect(JSON.stringify(close?.error)).toMatch(/close reason|close_reason/i);
    });
  }
);
