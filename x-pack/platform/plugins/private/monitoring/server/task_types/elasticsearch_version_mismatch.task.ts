/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { RULE_ELASTICSEARCH_VERSION_MISMATCH } from '../../common/constants';
import { ElasticsearchVersionMismatchRule } from '../rules/elasticsearch_version_mismatch_rule';
import { createMonitoringRuleTaskType } from './monitoring_rule_task_type';

/** The `RULE_ELASTICSEARCH_VERSION_MISMATCH` rule type, which a task process can run. */
export const taskType = createMonitoringRuleTaskType(
  RULE_ELASTICSEARCH_VERSION_MISMATCH,
  () => new ElasticsearchVersionMismatchRule()
);
