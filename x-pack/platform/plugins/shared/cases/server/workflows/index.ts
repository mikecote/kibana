/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import type { CasesClient } from '../client';
import type { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';

import { casesStepRegistry } from './registry';
import { createCaseFromTemplateStepDefinition } from './steps/create_case_from_template';
import { setExtendedFieldsStepDefinition } from './steps/set_extended_fields';

/**
 * What the cases steps need to run: Kibana builds it from the plugin's services and a task process
 * from its host (`createCasesRunServices`), so the handlers never reach for plugin state.
 */
export interface CasesWorkflowStepServices {
  getCasesClient: (request: KibanaRequest) => Promise<CasesClient>;
  isTemplatesEnabled: boolean;
  /**
   * `cases.addAttachments` and its flag. It reads the attachment type registry that solutions fill
   * in their own `setup()`; task processes restore them through native contributions.
   */
  addAttachments?: {
    unifiedAttachmentTypeRegistry: UnifiedAttachmentTypeRegistry;
    /**
     * Resolves when solution-contributed attachment definitions are available to build the input schema.
     */
    waitForAttachmentTypes: () => Promise<void>;
  };
}

/**
 * Registers the cases steps: what `plugin.ts` calls with Kibana's services and the contribution to
 * the task process of the workflow task types calls with the services of the process.
 */
export function registerCaseWorkflowSteps(
  registry: Pick<WorkflowStepsRegistry, 'registerStepDefinition'> | undefined,
  { getCasesClient, isTemplatesEnabled, addAttachments }: CasesWorkflowStepServices
) {
  if (!registry) {
    return;
  }

  for (const factory of casesStepRegistry) {
    const definition = factory(getCasesClient);
    registry.registerStepDefinition(definition);
  }

  // `cases.createCaseFromTemplate` is registered in every flag state: with the templates feature
  // on it prefers a `cases-template` saved object (server-side expansion pins the version); with it
  // off it falls back to the per-space configuration templates. The flag is threaded in so the step
  // knows which lookup to try first.
  registry.registerStepDefinition(
    createCaseFromTemplateStepDefinition(getCasesClient, isTemplatesEnabled)
  );

  // `cases.setExtendedFields` writes to the extended_fields surface, which is gated by the same
  // templates feature flag that gates field definitions and template CRUD — register it only when
  // the feature is on so a workflow can't target fields the deployment can't define.
  if (isTemplatesEnabled) {
    registry.registerStepDefinition(setExtendedFieldsStepDefinition(getCasesClient));
  }

  // `cases.addAttachments` is registered separately from the uniform registry:
  // it is flag-gated, needs the attachment registry, and must defer until
  // solution-contributed types have registered (see `waitForAttachmentTypes`).
  if (addAttachments) {
    const { unifiedAttachmentTypeRegistry, waitForAttachmentTypes } = addAttachments;
    registry.registerStepDefinition(async () => {
      await waitForAttachmentTypes();
      const { addAttachmentsStepDefinition } = await import('./steps/add_attachments');
      return addAttachmentsStepDefinition(unifiedAttachmentTypeRegistry, getCasesClient);
    });
  }
}
