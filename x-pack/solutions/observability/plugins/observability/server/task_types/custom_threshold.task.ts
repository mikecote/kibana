/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { OBSERVABILITY_THRESHOLD_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { createDiscoverAppLocatorDefinition } from '@kbn/discover-plugin/common/task_process_locator';
import { DISCOVER_APP_LOCATOR } from '@kbn/discover-plugin/common';
import { alertsLocatorID } from '../../common';
import { AlertsLocatorDefinition } from '../../common/locators/alerts';
import type { ObservabilityConfig } from '..';
import { thresholdRuleType } from '../lib/rules/custom_threshold/register_custom_threshold_rule_type';

/** The custom threshold rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: OBSERVABILITY_THRESHOLD_RULE_TYPE_ID,
    getRuleType: ({ logger, publicBaseUrl, settings, locators }) =>
      thresholdRuleType(
        // Only its query inspector reads the start services, which a rule run does not use.
        {
          getStartServices: () => Promise.reject(new Error('Not available in a task process')),
        } as never,
        { publicBaseUrl } as never,
        settings.observability as ObservabilityConfig,
        logger,
        {
          alertsLocator: locators.get(alertsLocatorID),
          logsLocator: locators.get(DISCOVER_APP_LOCATOR),
        }
      ) as never,
  },
  {
    locators: [new AlertsLocatorDefinition(), createDiscoverAppLocatorDefinition()],
  }
);
