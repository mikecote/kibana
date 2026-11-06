/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { analyticsServiceMock } from '@kbn/core-analytics-server-mocks';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { RULE_RUN_CONTRIBUTIONS } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import {
  ATTACK_DISCOVERY_EVENT_PROVIDER,
  ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS,
} from '@kbn/discoveries';
import { ATTACK_DISCOVERY_WORKFLOWS_ENABLED_FEATURE_FLAG } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import { getAttackDiscoveryScheduleType } from '../lib/attack_discovery/schedules/register_schedule/definition';
import {
  declineUnsupportedWorkflowStorage,
  getUnsupportedStorage,
  taskType,
} from './attack_discovery.task';

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

  describe('declining a rule', () => {
    const settings = (source: string) => ({ workflowsExecutionEngine: { storage: { source } } });

    it('declines a workflow rule whose executions are not stored in a plain index', () => {
      expect(
        declineUnsupportedWorkflowStorage({
          settings: settings('data_stream'),
          ruleParams: { workflowConfig: { workflowId: 'w' } },
        })
      ).toMatch(/"data_stream" are only available in Kibana/);
    });

    it('serves a workflow rule stored in a plain index, and a rule without workflows whatever the storage', () => {
      expect(
        declineUnsupportedWorkflowStorage({
          settings: settings('plain_index'),
          ruleParams: { workflowConfig: {} },
        })
      ).toBeUndefined();
      expect(
        declineUnsupportedWorkflowStorage({ settings: settings('data_stream'), ruleParams: {} })
      ).toBeUndefined();
    });

    it('describes the storage of an engine config', () => {
      expect(
        getUnsupportedStorage({ storage: { source: 'plain_index' } } as never)
      ).toBeUndefined();
      expect(getUnsupportedStorage(undefined)).toBeUndefined();
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
      ATTACK_DISCOVERY_WORKFLOW_EXECUTOR_CONTRIBUTIONS,
    ]);
  });

  it('keeps its declarations when the contributions are applied', () => {
    const applied = taskType.contributions!.apply!({});
    expect(applied.featureFlags).toEqual(taskType.featureFlags);
    expect(applied.eventLog?.providers).toEqual(taskType.eventLog?.providers);
    expect(applied.type).toBe(taskType.type);
  });
});
