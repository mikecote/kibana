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
  createGetApmIndices,
  apmIndicesSavedObjectDefinition,
  type APMIndices,
} from '@kbn/apm-sources-access-plugin/server';
import {
  createMlTaskProcessServices,
  getMlTaskProcessSavedObjectTypes,
} from '@kbn/ml-plugin/server/task_types/ml_task_process_services';
import type { APMConfig } from '..';
import type { RegisterRuleDependencies } from '../routes/alerts/register_apm_rule_types';

/** What the APM and APM sources plugins give their rule types in a task process. */
export interface ApmTaskProcessSettings {
  apm: APMConfig;
  apmSourcesAccess: { indices: APMIndices };
}

/**
 * The task type of one of the APM rule types. They have no factory of their own: the plugin
 * registers each through a function that takes its dependencies, so this runs that function against
 * a stand-in for the alerting contract that keeps the rule type.
 */
export const createApmRuleTaskType = (
  ruleTypeId: string,
  register: (dependencies: RegisterRuleDependencies) => void,
  /** The rule type reads the machine learning services of the `ml` plugin. */
  options: { usesMl?: boolean } = {}
) =>
  createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: (deps) => {
        const { logger, publicBaseUrl, settings, locators } = deps;
        const ml = options.usesMl ? createMlTaskProcessServices(deps) : undefined;
        const ruleType = getRuleTypeFromRegistration((alerting) =>
          register({
            alerting,
            basePath: { publicBaseUrl },
            // What the APM sources plugin does: the indices of the config, overridden by the saved object.
            getApmIndices: createGetApmIndices(
              () =>
                (settings.apmSourcesAccess as ApmTaskProcessSettings['apmSourcesAccess']).indices
            ),
            apmConfig: settings.apm as APMConfig,
            logger: logger.get('rule'),
            alertsLocator: locators.get(alertsLocatorID),
            // The rule types of this module do not use these two.
            observability: undefined,
            ruleDataClient: undefined,
            ml: ml?.sharedServicesProviders,
          } as never)
        );
        return (ml ? ml.withLicense(ruleType) : ruleType) as never;
      },
    },
    {
      locators: [new AlertsLocatorDefinition()],
      savedObjectTypes: [
        apmIndicesSavedObjectDefinition,
        ...(options.usesMl ? getMlTaskProcessSavedObjectTypes() : []),
      ],
    }
  );
