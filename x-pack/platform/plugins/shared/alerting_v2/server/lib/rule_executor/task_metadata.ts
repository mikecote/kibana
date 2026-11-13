/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { PluginConfig } from '../../config';
import {
  ALERTING_RULE_EXECUTOR_TASK_TYPE,
  DEFAULT_ALERTING_RULE_EXECUTOR_TASK_TIMEOUT,
} from './constants';

export const RULE_EXECUTOR_TASK_METADATA = {
  taskType: ALERTING_RULE_EXECUTOR_TASK_TYPE,
  title: 'Alerting v2 rule executor (ES|QL)',
  timeout: DEFAULT_ALERTING_RULE_EXECUTOR_TASK_TIMEOUT,
  paramsSchema: schema.object({ ruleId: schema.string(), spaceId: schema.string() }),
};

/** Resolves the configured rule-executor timeout for native task registration. */
export const getRuleExecutorTaskTimeout = (config: PluginConfig): string =>
  config.rules.run.timeout ?? DEFAULT_ALERTING_RULE_EXECUTOR_TASK_TIMEOUT;
