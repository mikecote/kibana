/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID } from '@kbn/alerting-plugin/server/task_types/alerting_authorization_task_process_settings';
import { RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID } from './rule_data_task_process_services';
import { createWorkflowAlertsClient } from './create_workflow_alerts_client';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [
      ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
      RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID,
      'alerting',
    ],
  },
  provides: {
    ruleRegistry: ({ host, services }) => {
      if (!services)
        throw new Error('Authorized alert access requires workflow execution services');
      return createWorkflowAlertsClient(host as TaskHost, services);
    },
  },
  register: () => {},
};
