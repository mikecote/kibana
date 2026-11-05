/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger, SavedObjectsType } from '@kbn/core/server';
import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';
import type { RuleRunActionsSetup } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import type { AlertingServerSetup } from '../plugin';

/** The contribution key under which plugins add what every rule run needs: see `kibana.jsonc`. */
export const RULE_RUN_CONTRIBUTIONS = 'alerting-rule-run';

/** What a contribution may use when it registers: the process, not the plugins around it. */
export interface RuleRunContributionContext {
  logger: Logger;
  isServerless: boolean;
  kibanaVersion: string;
  publicBaseUrl?: string;
  /** The validated configs Kibana sent, by plugin id (see `registerTaskProcessSettings`). */
  settings: Record<string, unknown>;
}

/** The parts of the actions and alerting setup contracts a plugin registers its connectors through. */
export interface RuleRunRegistries {
  actions: RuleRunActionsSetup;
  alerting: Pick<AlertingServerSetup, 'registerConnectorAdapter'>;
}

/**
 * What a plugin adds to a rule run in a task process, as it adds it to Kibana in its `setup()`: the
 * connector types and connector adapters of system actions, and the saved object types they read.
 * Exported as `contribution` from a file listed under `taskTypeContributions` in the plugin's
 * `kibana.jsonc`, so a rule type never has to know about the plugins that add connectors.
 */
export interface RuleRunContribution {
  declares?: {
    savedObjectTypes?: SavedObjectsType[];
    encryptedSavedObjectTypes?: EncryptedSavedObjectTypeRegistration[];
  };
  register?: (registries: RuleRunRegistries, context: RuleRunContributionContext) => void;
}
