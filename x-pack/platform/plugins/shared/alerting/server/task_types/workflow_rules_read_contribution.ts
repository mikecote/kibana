/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SearchSourceService } from '@kbn/data-plugin/common';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { ACTIONS_CONNECTORS_SETTINGS_ID } from '@kbn/actions-plugin/server/task_types/task_process_settings';
import type { ActionsTaskProcessSettings } from '@kbn/actions-plugin/server/task_types/task_process_settings';
import { getRuleSavedObjectType, ruleEncryptedSavedObjectType } from '../saved_objects';
import { createWorkflowRulesReadServices } from './create_workflow_rules_read_client';
import { ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID } from './alerting_authorization_task_process_settings';
import { RULE_READ_CONTRIBUTIONS_KEY, RULE_READ_SETTINGS_ID } from './rule_read_contribution';
import type { RuleReadSettings } from './rule_read_contribution';

export const contribution: WorkflowStepsContribution = {
  declares: {
    contributionKeys: [RULE_READ_CONTRIBUTIONS_KEY],
    settings: [RULE_READ_SETTINGS_ID, ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID],
    createSavedObjectTypes: (encryptedSavedObjects, settings) => {
      const snapshot = settings[RULE_READ_SETTINGS_ID] as RuleReadSettings | undefined;
      if (!snapshot) return [];
      encryptedSavedObjects.registerType(ruleEncryptedSavedObjectType);
      const actions = settings[ACTIONS_CONNECTORS_SETTINGS_ID] as
        | ActionsTaskProcessSettings
        | undefined;
      if (!actions)
        throw new Error('Native rule saved objects require connector registration metadata');
      const registry = new Map(snapshot.ruleTypes.map((ruleType) => [ruleType.id, ruleType]));
      return [
        getRuleSavedObjectType({
          encryptedSavedObjects,
          searchSourceMigrations: new SearchSourceService().setup().getAllMigrations(),
          isPreconfigured: (id) =>
            actions.inMemoryConnectors.some(
              (connector) => connector.id === id && connector.isPreconfigured
            ),
          isExportable: (rule) => registry.get(rule.attributes.alertTypeId)?.isExportable ?? false,
        }),
      ];
    },
  },
  provides: {
    alerting: ({ host, services }) => {
      if (!services) throw new Error('Native rule readers require workflow execution services');
      return createWorkflowRulesReadServices({
        host: host as TaskHost,
        services,
        registerCleanup: (cleanup) => services.registerRunCompletion(async () => cleanup()),
      });
    },
  },
  register: () => {},
};
