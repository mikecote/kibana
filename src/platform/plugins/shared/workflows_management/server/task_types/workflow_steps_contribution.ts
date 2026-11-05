/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerConnectorEventTriggers } from '../triggers/register_connector_event_triggers';

/**
 * The connector event triggers, built from the connector specs, in the task process of the workflow
 * task types. Whether inbound events are enabled is read from the config of the actions plugin, as
 * Kibana reads it. Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { settings }) => {
    const actions = settings.actions as { inboundEvents?: { enabled?: boolean } } | undefined;
    registerConnectorEventTriggers({
      inboundEventsEnabled: actions?.inboundEvents?.enabled === true,
      registerTriggerDefinition: (definition) => registry.registerTriggerDefinition(definition),
    });
  },
};
