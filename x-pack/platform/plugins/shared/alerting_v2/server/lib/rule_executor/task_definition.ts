/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AlertingTaskDefinition } from '../services/task_run_scope_service/create_task_runner';
import { RuleExecutorTaskRunner } from './task_runner';
import { RULE_EXECUTOR_TASK_METADATA, getRuleExecutorTaskTimeout } from './task_metadata';

/**
 * Task definition for rule executor.
 * Bound to TaskDefinition token and automatically registered with Task Manager on setup.
 */
export const RuleExecutorTaskDefinition: AlertingTaskDefinition<RuleExecutorTaskRunner> = {
  ...RULE_EXECUTOR_TASK_METADATA,
  resolveTimeout: getRuleExecutorTaskTimeout,
  taskRunnerClass: RuleExecutorTaskRunner,
  requiresFakeRequest: true,
};
