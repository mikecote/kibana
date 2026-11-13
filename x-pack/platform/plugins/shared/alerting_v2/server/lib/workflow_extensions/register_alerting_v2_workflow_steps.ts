/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import type { AlertEventsClientApi } from '../../types';
import { registerCreateAlertEventStep } from './register_create_alert_event_step';
import { registerTriggerDefinitions } from './register_trigger_definitions';

export interface AlertingV2WorkflowStepsServices {
  getAlertEventsClient: (request: KibanaRequest) => Promise<AlertEventsClientApi>;
  checkAlertWritePrivilege: (request: KibanaRequest) => Promise<boolean>;
}

/**
 * Registers the workflow step and triggers of the plugin, in Kibana (`bind_on_setup`, with services
 * from the container) and in a task process (the `workflow-steps` contribution, with services built
 * from the host).
 */
export const registerAlertingV2WorkflowSteps = (
  registry: WorkflowStepsRegistry,
  services: AlertingV2WorkflowStepsServices
): void => {
  registerTriggerDefinitions(registry);
  registerCreateAlertEventStep(
    registry,
    services.getAlertEventsClient,
    services.checkAlertWritePrivilege
  );
};
