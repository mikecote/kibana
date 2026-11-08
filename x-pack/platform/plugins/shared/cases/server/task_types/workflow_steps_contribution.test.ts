/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { registerInternalAttachments } from '../internal_attachments';
import { ConfigSchema } from '../config';
import { of } from 'rxjs';
import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepRunCheck } from '@kbn/workflows-extensions/server';
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
import { registerCaseWorkflowTriggers } from '../workflows/triggers';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';
import { contribution } from './workflow_steps_contribution';

const attachmentRegistry = new UnifiedAttachmentTypeRegistry();
registerInternalAttachments(attachmentRegistry);

const workflowsSettings: CasesWorkflowsProcessSettings = {
  config: {
    templates: { enabled: true },
    assigneeIdentity: { enabled: true },
    attachments: { enabled: true },
    analyticsV2: { enabled: false },
    files: ConfigSchema.validate({}).files,
  },
  spacesEnabled: true,
  attachmentTypeIds: attachmentRegistry.list().map(({ id }) => id),
  featureCaseOwners: [{ id: 'securitySolutionCasesV3', cases: ['securitySolution'] }],
  isEmailServiceAvailable: false,
  hasAlertStatusChangedListeners: false,
  closeReasonOwners: [],
};

const registerContribution = async (
  workflows: typeof workflowsSettings | null = workflowsSettings
) => {
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
        createSerializer: jest.fn(),
      },
      security: { authc: {}, fips: { isEnabled: jest.fn(() => false) } },
      userProfile: {},
      analytics: { reportEvent: jest.fn() },
      licensing: { license$: of(license), featureUsage: { notifyUsage: jest.fn() } },
      usageCounters: {
        getUsageCounter: jest.fn((domainId: string) => ({ domainId, incrementCounter: jest.fn() })),
      },
      plugins: { security: { authz: { actions: {} }, audit: {} } },
    },
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings: {
      ...(workflows
        ? { cases: { isCasesAttachmentsEnabled: true, isTemplatesEnabled: true, workflows } }
        : {}),
    },
    services: {
      stepRegistry: createServerStepRegistry(loggerMock.create()),
      registerService: jest.fn(),
      registerRunCompletion: jest.fn(),
      getService: jest
        .fn()
        .mockImplementation((id: string) =>
          id === 'spaces'
            ? { spacesService: { getActiveSpace: jest.fn(), getSpaceId: jest.fn() } }
            : { registry: attachmentRegistry, getParityError: () => undefined }
        ),
      getExecutionEngine: jest.fn(),
      getUnsecuredActionsClient: jest.fn(),
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
const registeredByKibana = async () => {
  const registry = createServerStepRegistry(loggerMock.create());
  registerCaseWorkflowSteps(registry, {
    getCasesClient: jest.fn(),
    isTemplatesEnabled: true,
    addAttachments: {
      unifiedAttachmentTypeRegistry: attachmentRegistry,
      waitForAttachmentTypes: () => Promise.resolve(),
    },
  });
  registerCaseWorkflowTriggers(registry);
  await registry.isReady();
  return {
    steps: registry
      .getAllStepDefinitions()
      .map(({ id }) => id)
      .filter((id) => id.startsWith('cases.')),
    triggers: registry
      .getAllTriggerDefinitions()
      .map(({ id }) => id)
      .filter((id) => id.startsWith('cases.')),
  };
};

describe('cases workflow-steps contribution', () => {
  it('registers every step and trigger Kibana registers', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution();
    const kibana = await registeredByKibana();

    expect(kibana.steps.length).toBeGreaterThan(30);
    expect(kibana.triggers).toHaveLength(8);
    for (const id of [
      'cases.addAlerts',
      'cases.addAttachments',
      'cases.addEvents',
      'cases.deleteAttachments',
      'cases.deleteCases',
    ]) {
      expect(registry.hasStepDefinition(id)).toBe(true);
    }
    kibana.steps.forEach((id) => expect(registry.hasStepDefinition(id)).toBe(true));
    expect(registry.getAllStepDefinitions().length).toBe(internalSteps + kibana.steps.length);

    kibana.triggers.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
    expect(registry.getAllTriggerDefinitions().length).toBe(internalTriggers + 8);
  });

  it('registers nothing when Kibana sent no cases settings, as when cases is disabled', async () => {
    const { registry, internalSteps, internalTriggers } = await registerContribution(null);

    expect(registry.getAllStepDefinitions()).toHaveLength(internalSteps);
    expect(registry.getAllTriggerDefinitions()).toHaveLength(internalTriggers);
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
    for (const id of [
      'cases.addAlerts',
      'cases.addAttachments',
      'cases.addEvents',
      'cases.deleteAttachments',
      'cases.deleteCases',
    ]) {
      expect(decline(quiet.checks, id)).toBeUndefined();
    }
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
