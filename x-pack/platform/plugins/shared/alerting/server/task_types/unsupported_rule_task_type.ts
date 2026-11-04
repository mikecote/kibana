/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { stateSchemaByVersion } from '@kbn/alerting-state-types';
import { DeclinedRunError } from '@kbn/task-manager-plugin/server/task_running/errors';
import { defineTaskType } from '@kbn/task-manager-plugin/server/task_type_module';
import { TaskTypeGroup } from '@kbn/task-manager-plugin/server/task';
import { ruleTaskParamsSchema } from './rule_task_params_schema';

/**
 * The task type of a rule type that a task process cannot run yet, `alerting:<id>`. Its bundle is
 * small and declines every run, so Kibana runs the rule, exactly as if the rule type had no bundle,
 * until its executor can be built from the task host. `reason` says what is missing.
 */
export const createUnsupportedRuleTaskType = (ruleTypeId: string, reason: string) =>
  defineTaskType({
    type: `alerting:${ruleTypeId}`,
    stateSchemaByVersion,
    taskTypeGroup: TaskTypeGroup.Alerting,
    paramsSchema: ruleTaskParamsSchema,
    createTaskRunner: () => ({
      run: async () => {
        throw new DeclinedRunError(
          `alerting:${ruleTypeId} cannot run in a task process: ${reason}`
        );
      },
    }),
  });
