/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { InMemoryConnector } from '../types';

/** The id under which Kibana sends `ActionsTaskProcessSettings` to a task process. */
export const ACTIONS_CONNECTORS_SETTINGS_ID = 'actionsConnectors';

/** The parity kinds the actions plugin has: see `TaskProcessParity` in Task Manager. */
export const CONNECTOR_TYPES_PARITY_KIND = 'connectorTypes';

/**
 * What a task process needs of the actions plugin to behave as this Kibana does, as Kibana has it
 * when the run is dispatched. It holds the secrets of preconfigured connectors, so never log it.
 */
export interface ActionsTaskProcessSettings {
  /**
   * Kibana's final in-memory connectors: preconfigured ones that did not conflict with a saved
   * connector, dynamic ones other plugins registered, and the system connectors, with the
   * `isPreconfigured` and `isDeprecated` flags Kibana computed. The process does not rebuild them
   * from its config.
   */
  inMemoryConnectors: InMemoryConnector[];
}
