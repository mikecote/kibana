/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { escapeRegExp } from 'lodash';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type {
  WorkflowStepsContribution,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import { maintenanceWindowSavedObjectType } from '@kbn/maintenance-windows-plugin/server/saved_objects';
import { getRuleTemplateSavedObjectType } from '@kbn/alerting-plugin/server/saved_objects';
import { ESQL_RESPONSE_FORMAT_FEATURE_FLAG } from '../../common/feature_flags';
import { registerAlertingV2WorkflowSteps } from '../lib/workflow_extensions/register_alerting_v2_workflow_steps';
import { DEFAULT_ESQL_RESPONSE_FORMAT } from '../lib/services/query_service/formats';
import { PrivilegeChecker } from '../lib/services/privilege_checker/privilege_checker';
import { ALERTING_RULE_EXECUTOR_TASK_TYPE } from '../lib/rule_executor/constants';
import {
  ACTION_POLICY_EVENT_PROVIDER,
  ACTION_POLICY_EVENT_ACTIONS,
} from '../lib/dispatcher/steps/constants';
import { ruleChangeTelemetryEvents } from '../lib/telemetry/rule_ebt_event';
import {
  alertingGlobalAdvancedSettings,
  alertingSpaceAdvancedSettings,
} from '../settings/advanced_settings';
import {
  getAlertingV2SavedObjectTypes,
  getAlertingV2EncryptedSavedObjectTypes,
} from '../saved_objects';
import {
  createAlertingV2RunServices,
  type AlertingV2RunServices,
} from './create_alerting_v2_run_services';
import { ALERTING_V2_TASK_PROCESS_SETTINGS_ID } from './task_process_settings';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [ALERTING_V2_TASK_PROCESS_SETTINGS_ID],
    schedulableTypes: [new RegExp(`^${escapeRegExp(ALERTING_RULE_EXECUTOR_TASK_TYPE)}$`)],
    savedObjectTypes: [
      ...getAlertingV2SavedObjectTypes(),
      getRuleTemplateSavedObjectType(),
      maintenanceWindowSavedObjectType,
    ],
    encryptedSavedObjectTypes: getAlertingV2EncryptedSavedObjectTypes(),
    uiSettings: [alertingSpaceAdvancedSettings],
    globalUiSettings: [alertingGlobalAdvancedSettings],
    analyticsEventTypes: ruleChangeTelemetryEvents,
    eventLogProviders: [
      {
        provider: ACTION_POLICY_EVENT_PROVIDER,
        actions: Object.values(ACTION_POLICY_EVENT_ACTIONS),
      },
    ],
    featureFlags: { [ESQL_RESPONSE_FORMAT_FEATURE_FLAG]: DEFAULT_ESQL_RESPONSE_FORMAT.name },
  },
  provides: {
    'alertingV2.runtime': ({ host, services }) => {
      if (!services?.registerRunCompletion)
        throw new Error('Alerting v2 requires workflow execution completion');
      return createAlertingV2RunServices({
        host: host as TaskHost,
        workflowsManagement:
          services.getService<WorkflowsServerPluginSetup['management']>('workflows.management'),
        workflowsExtensions:
          services.getService<WorkflowsExtensionsServerPluginStart>('workflows.extensions'),
        spaces: services.getService<SpacesPluginStart>('spaces'),
        registerRunCompletion: services.registerRunCompletion,
      });
    },
    alertingVTwo: ({ services }) => {
      if (!services) throw new Error('Alerting v2 requires workflow execution services');
      return services.getService<AlertingV2RunServices>('alertingV2.runtime').contract;
    },
  },
  register: (registry, { services, settings }) => {
    if (!settings[ALERTING_V2_TASK_PROCESS_SETTINGS_ID]) return;
    if (!services) throw new Error('Alerting v2 requires workflow execution services');
    const getRuntime = () => services.getService<AlertingV2RunServices>('alertingV2.runtime');
    registerAlertingV2WorkflowSteps(registry, {
      getAlertEventsClient: async (request) => {
        const runtime = getRuntime();
        await runtime.ready();
        return runtime.contract.getAlertEventsClientWithRequest(request);
      },
      checkAlertWritePrivilege: (request) =>
        getRuntime().resolve(request, PrivilegeChecker).canWrite('alerts'),
    });
  },
};
