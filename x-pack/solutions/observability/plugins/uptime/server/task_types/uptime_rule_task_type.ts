/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { alertsLocatorID } from '@kbn/observability-plugin/common';
import { AlertsLocatorDefinition } from '@kbn/observability-plugin/common/locators/alerts';
import { uptimeRequests } from '../legacy_uptime/lib/requests';
import { licenseCheck } from '../legacy_uptime/lib/domains';

type UptimeRuleFactory = (server: never, libs: never, plugins: never) => unknown;

/**
 * The task type of one of the uptime rule types. They are built from a factory that takes the
 * plugin's server object, which these rule types only read the base path and the locators of.
 */
export const createUptimeRuleTaskType = (ruleTypeId: string, factory: UptimeRuleFactory) =>
  createRuleTaskType(
    {
      ruleTypeId,
      getRuleType: ({ publicBaseUrl, locators }) =>
        factory(
          {
            basePath: { publicBaseUrl },
            share: { url: { locators } },
            isDev: false,
          } as never,
          { requests: uptimeRequests, license: licenseCheck } as never,
          {} as never
        ) as never,
    },
    {
      locators: [new AlertsLocatorDefinition()],
    }
  );

export { alertsLocatorID };
