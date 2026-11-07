/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerImpactStepDefinitions } from '../impact/step_types';
import { registerInvestigationStepDefinitions } from '../investigations/step_types';
import { registerWorkflowExecutionStepDefinitions } from '../workflow_execution/step_types';
import { AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID } from './agentic_investigations_task_process_settings';
import { getAgenticInvestigationsTaskProcessServices } from './create_agentic_investigations_task_process_services';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID] },
  register: (registry, context) => {
    if (!context.settings[AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID]) return;
    const { services } = context;
    if (!services) throw new Error('Agentic investigations requires workflow execution services');
    const runtime = getAgenticInvestigationsTaskProcessServices({
      ...context,
      services: {
        getService: services.getService,
        getAgentBuilderStart: () => services.getService('agentBuilder'),
        getWorkflowsManagement: () => services.getService('workflows.management'),
      },
    });
    const getConversationClient = (request: KibanaRequest) =>
      runtime.getConversationClient({ request });
    registerImpactStepDefinitions({
      workflowsExtensions: registry,
      getImpactService: runtime.getImpactService,
      resolveUser: runtime.resolveUser,
      privileges: runtime.privileges,
      getAttachmentClient: (request) => runtime.getAttachmentClient({ request }),
      getConversationClient,
    });
    registerInvestigationStepDefinitions({
      workflowsExtensions: registry,
      getInvestigationStatusService: runtime.getInvestigationStatusService,
      getConversationClient,
    });
    registerWorkflowExecutionStepDefinitions({
      workflowsExtensions: registry,
      getConversationClient,
    });
  },
};
