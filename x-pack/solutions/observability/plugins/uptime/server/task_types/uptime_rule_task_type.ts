/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { alertsLocatorID } from '@kbn/observability-plugin/common';
import { AlertsLocatorDefinition } from '@kbn/observability-plugin/common/locators/alerts';
import {
  createMlTaskProcessServices,
  getMlTaskProcessSavedObjectTypes,
  ML_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/ml-plugin/server/task_types/ml_task_process_services';
import { uptimeRequests } from '../legacy_uptime/lib/requests';
import { licenseCheck } from '../legacy_uptime/lib/domains';

type UptimeRuleFactory = (server: never, libs: never, plugins: never) => unknown;

/**
 * The task type of one of the uptime rule types. They are built from a factory that takes the
 * plugin's server object, which these rule types only read the base path and the locators of.
 */
export const createUptimeRuleTaskType = (
  ruleTypeId: string,
  factory: UptimeRuleFactory,
  /** The rule type reads the machine learning services of the `ml` plugin. */
  options: { usesMl?: boolean } = {}
) =>
  createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: (deps) => {
        const { publicBaseUrl, locators } = deps;
        const ml =
          options.usesMl && deps.settings[ML_TASK_PROCESS_SETTINGS_ID]
            ? createMlTaskProcessServices(deps)
            : undefined;
        const ruleType = factory(
          {
            basePath: { publicBaseUrl },
            share: { url: { locators } },
            isDev: false,
          } as never,
          { requests: uptimeRequests, license: licenseCheck } as never,
          (ml ? { ml: ml.sharedServicesProviders } : {}) as never
        ) as { executor: (options: never) => Promise<unknown> };
        return (ml ? ml.withLicense(ruleType) : ruleType) as never;
      },
    },
    {
      locators: [new AlertsLocatorDefinition()],
      optionalSettings: options.usesMl ? [ML_TASK_PROCESS_SETTINGS_ID] : [],
      ...(options.usesMl ? { savedObjectTypes: getMlTaskProcessSavedObjectTypes() } : {}),
    }
  );

export { alertsLocatorID };
