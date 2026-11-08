/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CasesClientContribution } from '@kbn/cases-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { APP_ID } from '../../common/constants';
import { createSecurityCloseReasonValidator } from '../cases/close_reason_validator';
import { getDetectionsCloseReasonUiSettings } from '../ui_settings';
import { forwardCasesAlertStatusToSecuritySolution } from '../workflows/triggers/cases_alert_status_bridge';
import type { SecurityWorkflowEvents } from './workflow_steps_contribution';

export const contribution: CasesClientContribution = {
  closeReasonOwners: [APP_ID],
  providesAlertStatusListener: true,
  declares: { uiSettings: [getDetectionsCloseReasonUiSettings()] },
  create: ({ host: taskHost, services, logger }) => {
    const host = taskHost as TaskHost;
    if (!host.uiSettings || !services)
      throw new Error(
        'Native Security Cases services require scoped UI settings and workflow services'
      );
    const uiSettings = host.uiSettings;
    const { eventBus } = services.getService<SecurityWorkflowEvents>('securitySolution.events');
    return {
      closeReasonValidators: {
        [APP_ID]: createSecurityCloseReasonValidator(async (request) =>
          uiSettings.asScopedToClient(host.savedObjects.getScopedClient(request))
        ),
      },
      registerAlertStatusListener: eventBus
        ? (casesEventBus) => {
            casesEventBus.onAlertStatusChanged(({ request, payload }) => {
              forwardCasesAlertStatusToSecuritySolution(eventBus, logger, request, payload);
            });
          }
        : undefined,
    };
  },
};
