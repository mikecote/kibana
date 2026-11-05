/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck, WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { License } from '@kbn/licensing-plugin/common/license';
import {
  CASE_ATTACHMENT_SAVED_OBJECT,
  CASE_COMMENT_SAVED_OBJECT,
  CASE_CONFIGURE_SAVED_OBJECT,
  CASE_CONNECTOR_MAPPINGS_SAVED_OBJECT,
  CASE_FIELD_DEFINITION_SAVED_OBJECT,
  CASE_SAVED_OBJECT,
  CASE_TEMPLATE_SAVED_OBJECT,
  CASE_USER_ACTION_SAVED_OBJECT,
} from '../../common/constants';
import { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';
import { registerCaseWorkflowSteps } from '../workflows';
import { KIBANA_ONLY_CASES_STEPS } from '../workflows/kibana_only_steps';
import { registerCaseWorkflowTriggers } from '../workflows/triggers';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';
import { contribution } from './workflow_steps_contribution';

const workflowsSettings: CasesWorkflowsProcessSettings = {
  config: {
    templates: { enabled: true },
    assigneeIdentity: { enabled: true },
    attachments: { enabled: true },
    analyticsV2: { enabled: false },
  },
  spacesEnabled: true,
  featureCaseOwners: [{ id: 'securitySolutionCasesV3', cases: ['securitySolution'] }],
  isEmailServiceAvailable: false,
  hasAlertStatusChangedListeners: false,
  closeReasonOwners: [],
};

const registerContribution = async (workflows = workflowsSettings) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internalSteps = registry.getAllStepDefinitions().length;
  const internalTriggers = registry.getAllTriggerDefinitions().length;
  const checks: WorkflowStepRunCheck[] = [];
  const license = new License({
    license: {
      uid: 'uid',
      type: 'trial',
      mode: 'trial',
      status: 'active',
      expiryDateInMillis: Date.now() + 86400000,
    },
    features: { security: { isAvailable: true, isEnabled: true } },
    signature: 'sig',
  });
  await contribution.register(registry, {
    host: {
      elasticsearch: { asInternalUser: {}, asScoped: jest.fn() },
      savedObjects: {
        createInternalRepository: jest.fn(),
        getScopedClient: jest.fn(),
        getTypeRegistry: jest.fn(),
      },
      security: { authc: {} },
      userProfile: {},
      licensing: { license$: of(license), featureUsage: { notifyUsage: jest.fn() } },
      telemetry: { report: jest.fn() },
      plugins: { security: { authz: { actions: {} }, audit: {} } },
    },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: {
      cases: { isCasesAttachmentsEnabled: true, isTemplatesEnabled: true, workflows },
    },
    services: {
      executionDataClients: {
        createWorkflowDataClient: jest.fn(),
        createStepDataClient: jest.fn(),
      },
      getActionsClientWithRequest: jest.fn(),
      emitEvent: jest.fn(),
    },
    registerRunCheck: (check) => checks.push(check),
  });
  await registry.isReady();
  return { registry, internalSteps, internalTriggers, checks };
};

/** The ids Kibana registers: what `plugin.ts` registers through the same function. */
const registeredByKibana = () => {
  const steps: string[] = [];
  const loaders: unknown[] = [];
  const triggers: string[] = [];
  const registry = {
    registerStepDefinition: (definition: { id?: string }) =>
      typeof definition === 'function' ? loaders.push(definition) : steps.push(definition.id!),
    registerTriggerDefinition: (definition: { id: string }) => triggers.push(definition.id),
  } as unknown as WorkflowStepsRegistry;
  registerCaseWorkflowSteps(registry, {
    getCasesClient: jest.fn(),
    isTemplatesEnabled: true,
    addAttachments: {
      unifiedAttachmentTypeRegistry: new UnifiedAttachmentTypeRegistry(),
      waitForStartServices: jest.fn(),
    },
  });
  registerCaseWorkflowTriggers(registry);
  return { steps, loaders, triggers };
};

describe('cases workflow-steps contribution', () => {
  it('registers every step and trigger Kibana registers, except the ones that only Kibana serves', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution();
    const kibana = registeredByKibana();

    expect(kibana.steps.length).toBeGreaterThan(30);
    // Only `cases.addAttachments` is a loader (it waits for the attachment types of the solutions).
    expect(kibana.loaders).toHaveLength(1);
    expect(kibana.triggers).toHaveLength(8);

    const declined = Object.keys(KIBANA_ONLY_CASES_STEPS);
    expect(declined.sort()).toEqual([
      'cases.addAlerts',
      'cases.addAttachments',
      'cases.addEvents',
      'cases.deleteAttachments',
      'cases.deleteCases',
    ]);
    // `cases.addAttachments` is the loader.
    declined
      .filter((id) => id !== 'cases.addAttachments')
      .forEach((id) => expect(kibana.steps).toContain(id));
    declined.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(false));

    const served = kibana.steps.filter((id) => !declined.includes(id));
    served.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + served.length);

    kibana.triggers.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
    expect(registry.getAllTriggerDefinitions().length).toBe(internalTriggers + 8);
  });

  it('registers setExtendedFields only when the templates feature is on', async () => {
    const withoutTemplates = await registerContribution({
      ...workflowsSettings,
      config: { ...workflowsSettings.config, templates: { enabled: false } },
    });
    expect(withoutTemplates.registry.hasStepDefinition('cases.setExtendedFields')).toBe(false);
    expect(withoutTemplates.registry.hasStepDefinition('cases.createCaseFromTemplate')).toBe(true);
  });

  it('declares the saved object types, the space type and the settings of the steps', () => {
    const names = contribution.declares?.savedObjectTypes?.map(({ name }) => name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        CASE_SAVED_OBJECT,
        CASE_COMMENT_SAVED_OBJECT,
        CASE_ATTACHMENT_SAVED_OBJECT,
        CASE_USER_ACTION_SAVED_OBJECT,
        CASE_CONFIGURE_SAVED_OBJECT,
        CASE_CONNECTOR_MAPPINGS_SAVED_OBJECT,
        CASE_TEMPLATE_SAVED_OBJECT,
        CASE_FIELD_DEFINITION_SAVED_OBJECT,
        'space',
      ])
    );
    expect(contribution.declares?.settings).toEqual(['cases']);
  });

  it('declines the steps a process cannot serve like Kibana, by what Kibana has', async () => {
    const quiet = await registerContribution();
    const busy = await registerContribution({
      ...workflowsSettings,
      isEmailServiceAvailable: true,
      hasAlertStatusChangedListeners: true,
      closeReasonOwners: ['securitySolution'],
    });
    const decline = (checks: WorkflowStepRunCheck[], type: string, config = {}) =>
      checks.map((check) => check({ type, config })).find(Boolean);
    const declined = Object.keys(KIBANA_ONLY_CASES_STEPS);

    // Declined by name, whatever Kibana has.
    declined.forEach((id) => expect(decline(quiet.checks, id)).toEqual(expect.any(String)));
    expect(decline(quiet.checks, 'cases.setStatus')).toBeUndefined();
    expect(decline(quiet.checks, 'cases.assignCase')).toBeUndefined();
    expect(decline(quiet.checks, 'cases.updateCase', { updates: { closeReason: 'x' } })).toBe(
      undefined
    );

    expect(decline(busy.checks, 'cases.setStatus')).toMatch(/event bus/);
    expect(decline(busy.checks, 'cases.closeCase')).toMatch(/event bus/);
    expect(
      decline(busy.checks, 'cases.updateCase', { with: { updates: { status: 'closed' } } })
    ).toMatch(/event bus/);
    expect(decline(busy.checks, 'cases.updateCase', { with: { updates: { title: 't' } } })).toBe(
      undefined
    );
    expect(
      decline(busy.checks, 'cases.updateCases', { with: { cases: [{ closeReason: 'x' }] } })
    ).toMatch(/close reason/);
    expect(decline(busy.checks, 'cases.assignCase')).toMatch(/emails/);
    expect(
      decline(busy.checks, 'cases.createCase', { with: { assignees: [{ uid: 'u' }] } })
    ).toMatch(/emails/);
    expect(decline(busy.checks, 'cases.createCase', { with: { title: 't' } })).toBeUndefined();
    expect(decline(busy.checks, 'cases.getCase')).toBeUndefined();
  });
});
