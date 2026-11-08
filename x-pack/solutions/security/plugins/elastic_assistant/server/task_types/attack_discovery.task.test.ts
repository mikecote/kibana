/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { analyticsServiceMock } from '@kbn/core-analytics-server-mocks';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { TASK_SCHEDULING_CONTRIBUTIONS_KEY } from '@kbn/task-manager-plugin/server/task_scheduling_contribution';
import { RULE_RUN_CONTRIBUTIONS } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import {
  ATTACK_DISCOVERY_EVENT_PROVIDER,
  ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS,
} from '@kbn/discoveries';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import { getAttackDiscoveryScheduleType } from '../lib/attack_discovery/schedules/register_schedule/definition';
import { taskType } from './attack_discovery.task';

describe('attack_discovery task type module', () => {
  it('builds the rule type that the plugin registers', () => {
    expectModuleToMatchRegisteredRuleType(
      taskType,
      getAttackDiscoveryScheduleType({
        getInference: () => undefined,
        getWorkflowExecutorFactory: () => undefined,
        logger: loggingSystemMock.createLogger(),
        publicBaseUrl: undefined,
        telemetry: analyticsServiceMock.createAnalyticsServiceSetup(),
      })
    );
  });

  describe('native workflow storage', () => {
    it('registers execution data streams with the current retention for workflow rules', () => {
      const definitions = taskType.createDataStreams?.({
        workflowsExecutionEngine: { storage: { source: 'data_stream', dataRetention: '9d' } },
      });
      expect(definitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: '.workflows-executions-data-stream',
            template: expect.objectContaining({ lifecycle: { data_retention: '9d' } }),
          }),
          expect.objectContaining({ name: '.workflows-step-executions-data-stream' }),
        ])
      );
    });

    it('keeps plain-index storage without registering execution data streams', () => {
      const definitions = taskType.createDataStreams?.({
        workflowsExecutionEngine: { storage: { source: 'plain_index', dataRetention: '9d' } },
      });
      expect(definitions?.map(({ name }) => name)).not.toContain(
        '.workflows-executions-data-stream'
      );
      expect(definitions?.map(({ name }) => name)).not.toContain(
        '.workflows-step-executions-data-stream'
      );
    });

    it('requires the dispatch workflow settings before initializing storage', () => {
      expect(() => taskType.createDataStreams?.({})).toThrow(
        'The attack discovery module did not get workflow settings'
      );
    });
  });

  it('executes the connectors of the rule and reads the prompt saved object', () => {
    expect(taskType.savedObjectTypes?.map(({ name }) => name)).toContain('security-ai-prompt');
    expect(taskType.eventLog?.providers.map(({ provider }) => provider)).toEqual(
      expect.arrayContaining([ATTACK_DISCOVERY_EVENT_PROVIDER])
    );
  });

  it('declares the feature flag it reads, the task encryption and the security plugin', () => {
    expect(taskType.featureFlags).toEqual({
      [ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG]: true,
    });
    expect(taskType.encryptedSavedObjectTypes?.map(({ type }) => type)).toEqual(
      expect.arrayContaining(['task', 'alert'])
    );
    expect(taskType.taskPlugins?.map(({ manifest }) => manifest.id)).toEqual([
      'security',
      'telemetry',
    ]);
    expect(taskType.taskManager).toEqual({
      schedulableTypes: expect.arrayContaining([/^workflow:run$/]),
    });
  });

  it('lists the contribution of the discoveries plugin next to the ones every rule run reads', () => {
    expect(taskType.contributions?.keys).toEqual([
      RULE_RUN_CONTRIBUTIONS,
      TASK_SCHEDULING_CONTRIBUTIONS_KEY,
      ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS,
    ]);
  });

  it('keeps its declarations when the contributions are applied', () => {
    const applied = taskType.contributions!.apply!({});
    expect(applied.featureFlags).toEqual(taskType.featureFlags);
    expect(applied.eventLog?.providers).toEqual(taskType.eventLog?.providers);
    expect(applied.type).toBe(taskType.type);
    expect(applied.createDataStreams).toBe(taskType.createDataStreams);
  });
});
