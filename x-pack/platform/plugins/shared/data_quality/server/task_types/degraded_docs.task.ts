/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEGRADED_DOCS_RULE_TYPE_ID } from '@kbn/rule-data-utils';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { ManagementAppLocatorDefinition } from '@kbn/management-plugin/common/locator';
import { DegradedDocsRuleType } from '@kbn/dataset-quality-plugin/server/rule_types/degraded_docs/register';
import {
  DatasetQualityDetailsLocatorDefinition,
  DatasetQualityLocatorDefinition,
} from '../../common/locators';

/** The `datasetQuality.degradedDocs` rule type, which a task process can run. */
export const taskType = createRuleTaskType(
  {
    ruleTypeId: DEGRADED_DOCS_RULE_TYPE_ID,
    getRuleType: ({ locators }) => DegradedDocsRuleType(locators) as never,
  },
  {
    // The links of an alert are built with the locators the data quality plugin registers, which
    // build their paths with the management locator.
    registerLocators: (locators) => {
      const managementLocator = locators.create(new ManagementAppLocatorDefinition());
      locators.create(new DatasetQualityLocatorDefinition({ useHash: false, managementLocator }));
      locators.create(
        new DatasetQualityDetailsLocatorDefinition({ useHash: false, managementLocator })
      );
    },
  }
);
