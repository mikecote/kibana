/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginConfig } from '../../config';
import { configSchema } from '../../config';
import { contribution as schedulingContribution } from '../../task_types/task_scheduling_contribution';
import { ALERTING_V2_TASK_PROCESS_SETTINGS_ID } from '../../task_types/task_process_settings';
import { RuleExecutorTaskDefinition } from './task_definition';
import { DEFAULT_ALERTING_RULE_EXECUTOR_TASK_TIMEOUT } from './constants';

const buildConfig = (timeout?: string): PluginConfig =>
  ({
    rules: {
      run: {
        alerts: { max: 1000 },
        timeout,
      },
    },
  } as PluginConfig);

describe('RuleExecutorTaskDefinition', () => {
  it('shares the native parameters schema with scheduling workers', () => {
    const schemas = schedulingContribution.createSchemas({
      [ALERTING_V2_TASK_PROCESS_SETTINGS_ID]: {
        config: configSchema.validate({}),
        agentBuilderEnabled: false,
        smlEnabled: false,
      },
    });
    expect(schemas[RuleExecutorTaskDefinition.taskType]?.paramsSchema).toBe(
      RuleExecutorTaskDefinition.paramsSchema
    );
    expect(schedulingContribution.createSchemas({})).toEqual({});
  });

  describe('resolveTimeout', () => {
    test('returns the configured timeout when set', () => {
      expect(RuleExecutorTaskDefinition.resolveTimeout?.(buildConfig('10m'))).toBe('10m');
    });

    test('falls back to the default timeout when the config timeout is unset', () => {
      expect(RuleExecutorTaskDefinition.resolveTimeout?.(buildConfig(undefined))).toBe(
        DEFAULT_ALERTING_RULE_EXECUTOR_TASK_TIMEOUT
      );
    });
  });
});
