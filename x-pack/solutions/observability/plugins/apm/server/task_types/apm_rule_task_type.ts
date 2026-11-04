/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { getRuleTypeFromRegistration } from '@kbn/alerting-plugin/server/task_types/capture_rule_type';
import { alertsLocatorID } from '@kbn/observability-plugin/common';
import { AlertsLocatorDefinition } from '@kbn/observability-plugin/common/locators/alerts';
import {
  apmIndicesSavedObjectDefinition,
  getApmIndicesSavedObject,
} from '@kbn/apm-sources-access-plugin/server/saved_objects/apm_indices';
import { registerConnectorTypesForRuleRuns } from '@kbn/stack-connectors-plugin/server/task_types/register_connector_types_for_rule_runs';
import type { APMConfig } from '..';
import type { RegisterRuleDependencies } from '../routes/alerts/register_apm_rule_types';

/** What the APM and APM sources plugins give their rule types in a task process. */
export interface ApmTaskProcessSettings {
  apm: APMConfig;
  apmSourcesAccess: { indices: Record<string, string> };
}

/**
 * The task type of one of the APM rule types. They have no factory of their own: the plugin
 * registers each through a function that takes its dependencies, so this runs that function against
 * a stand-in for the alerting contract that keeps the rule type.
 */
export const createApmRuleTaskType = (
  ruleTypeId: string,
  register: (dependencies: RegisterRuleDependencies) => void
) =>
  createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: ({ logger, publicBaseUrl, settings, locators }) =>
        getRuleTypeFromRegistration((alerting) =>
          register({
            alerting,
            basePath: { publicBaseUrl },
            // What the APM sources plugin does: the indices of the config, overridden by the saved object.
            getApmIndices: async (soClient: Parameters<typeof getApmIndicesSavedObject>[0]) => ({
              ...(settings.apmSourcesAccess as ApmTaskProcessSettings['apmSourcesAccess']).indices,
              ...(await getApmIndicesSavedObject(soClient)),
            }),
            apmConfig: settings.apm as APMConfig,
            logger: logger.get('rule'),
            alertsLocator: locators.get(alertsLocatorID),
            // The three rule types of this module do not use these.
            observability: undefined,
            ruleDataClient: undefined,
          } as never)
        ),
    },
    {
      locators: [new AlertsLocatorDefinition()],
      savedObjectTypes: [apmIndicesSavedObjectDefinition],
      registerConnectorTypes: registerConnectorTypesForRuleRuns,
    }
  );
