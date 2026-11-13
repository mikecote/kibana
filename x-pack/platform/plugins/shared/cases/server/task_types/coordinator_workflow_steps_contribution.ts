/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerCaseWorkflowSteps } from '../workflows';
import { registerCaseWorkflowTriggers } from '../workflows/triggers';
import { getCasesTaskProcessSavedObjectTypes } from './cases_saved_object_types';
import { createCasesAttachmentTypeRegistry } from './create_attachment_type_registry';
import type { CasesTaskProcessAttachmentTypes } from './create_attachment_type_registry';
import type { GetCasesClientOptions } from '../client/types';
import type { CasesTaskProcessSettings } from './cases_task_process_settings';
import { createCoordinatorCasesClient } from './coordinator_cases_client';

/** Local steps stay native; their client operations are coordinator-placed. Remote mode stays native. */
export const contribution: WorkflowStepsContribution = {
  declares: { savedObjectTypes: getCasesTaskProcessSavedObjectTypes(), settings: ['cases'] },
  provides: {
    'cases.attachmentTypes': ({ host, settings }) => {
      const workflows = (settings.cases as CasesTaskProcessSettings | undefined)?.workflows;
      if (!workflows) throw new Error('Cases attachment registrations require their snapshot');
      return createCasesAttachmentTypeRegistry(host as TaskHost, workflows.attachmentTypeIds);
    },
  },
  register: async (registry, context) => {
    const host = context.host as TaskHost;
    if (!host.withCoordinatorCapability) {
      // HTTP-supervised remote workers have no local Main session; preserve the native contribution.
      const native = await import('./workflow_steps_contribution');
      return native.contribution.register(registry, context);
    }
    const workflows = (context.settings.cases as CasesTaskProcessSettings | undefined)?.workflows;
    if (!workflows) return;
    if (!context.services) throw new Error('Cases workflow steps require engine services');
    const attachments =
      context.services.getService<CasesTaskProcessAttachmentTypes>('cases.attachmentTypes');
    context.registerRunCheck?.(({ type }) =>
      type.startsWith('cases.') ? attachments.getParityError() : undefined
    );
    registerCaseWorkflowTriggers(registry);
    registerCaseWorkflowSteps(registry, {
      getCasesClient: async (request, options?: GetCasesClientOptions) =>
        createCoordinatorCasesClient(host, request, options),
      isTemplatesEnabled: workflows.config.templates.enabled,
      addAttachments: workflows.config.attachments.enabled
        ? {
            unifiedAttachmentTypeRegistry: attachments.registry,
            waitForAttachmentTypes: async () => {},
          }
        : undefined,
    });
  },
};
