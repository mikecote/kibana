/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { configSchema as alertingConfigSchema } from '@kbn/alerting-plugin/server/config';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { config as ruleRegistryConfig } from '@kbn/rule-registry-plugin/server';
import { ConfigSchema as listsConfigSchema } from '@kbn/lists-plugin/server/config';
import { ruleRegistryMocks } from '@kbn/rule-registry-plugin/server/mocks';
import {
  EQL_RULE_TYPE_ID,
  ESQL_RULE_TYPE_ID,
  INDICATOR_RULE_TYPE_ID,
  ML_RULE_TYPE_ID,
  NEW_TERMS_RULE_TYPE_ID,
  QUERY_RULE_TYPE_ID,
  SAVED_QUERY_RULE_TYPE_ID,
  THRESHOLD_RULE_TYPE_ID,
} from '@kbn/securitysolution-rules';
import type { IRuleDataClient } from '@kbn/rule-registry-plugin/server';
import { createMockConfig } from '../config.mock';
import { getTaskProcessSettings } from '../config';
import {
  createEqlAlertType,
  createEsqlAlertType,
  createIndicatorMatchAlertType,
  createMlAlertType,
  createNewTermsAlertType,
  createQueryAlertType,
  createThresholdAlertType,
} from '../lib/detection_engine/rule_types';
import { createSecurityRuleTypeWrapper } from '../lib/detection_engine/rule_types/create_security_rule_type_wrapper';
import { taskType as eqlTaskType } from './eql.task';
import { taskType as esqlTaskType } from './esql.task';
import { taskType as indicatorMatchTaskType } from './indicator_match.task';
import { taskType as mlTaskType } from './ml.task';
import { taskType as newTermsTaskType } from './new_terms.task';
import { taskType as queryTaskType } from './query.task';
import { taskType as savedQueryTaskType } from './saved_query.task';
import { taskType as thresholdTaskType } from './threshold.task';

const config = createMockConfig();
const wrap = createSecurityRuleTypeWrapper({
  actions: { isActionTypeEnabled: () => true },
  lists: undefined,
  logger: loggingSystemMock.createLogger(),
  config,
  publicBaseUrl: undefined,
  ruleDataClient: ruleRegistryMocks.createRuleDataClient(
    '.alerts-security.alerts'
  ) as IRuleDataClient,
  ruleExecutionLoggerFactory: jest.fn(),
  version: '9.9.9',
  experimentalFeatures: config.experimentalFeatures,
  alerting: { getConfig: () => ({ run: { alerts: { max: 1000 } } } as never) },
  eventsTelemetry: undefined,
  licensing: { license$: undefined as never },
  scheduleNotificationResponseActionsService: jest.fn(),
  endpointAppContextService: {} as never,
  getEntityStore: jest.fn(),
  getRulesAuthz: jest.fn(),
});

const settings = {
  securitySolution: getTaskProcessSettings(config),
  ruleRegistry: ruleRegistryConfig.schema.validate({ write: { enabled: false } }),
  lists: listsConfigSchema.validate({}),
  actions: {},
  alerting: alertingConfigSchema.validate({}),
};

describe('detection rule task type modules', () => {
  it.each([
    [
      QUERY_RULE_TYPE_ID,
      queryTaskType,
      () => wrap(createQueryAlertType({ id: QUERY_RULE_TYPE_ID, name: 'Custom Query Rule' })),
    ],
    [
      SAVED_QUERY_RULE_TYPE_ID,
      savedQueryTaskType,
      () => wrap(createQueryAlertType({ id: SAVED_QUERY_RULE_TYPE_ID, name: 'Saved Query Rule' })),
    ],
    [ESQL_RULE_TYPE_ID, esqlTaskType, () => wrap(createEsqlAlertType())],
    [EQL_RULE_TYPE_ID, eqlTaskType, () => wrap(createEqlAlertType())],
    [INDICATOR_RULE_TYPE_ID, indicatorMatchTaskType, () => wrap(createIndicatorMatchAlertType())],
    [THRESHOLD_RULE_TYPE_ID, thresholdTaskType, () => wrap(createThresholdAlertType())],
    [NEW_TERMS_RULE_TYPE_ID, newTermsTaskType, () => wrap(createNewTermsAlertType())],
    [ML_RULE_TYPE_ID, mlTaskType, () => wrap(createMlAlertType({} as never))],
  ])('%s builds the rule type that the plugin registers', (_id, taskType, createRegistered) => {
    expectModuleToMatchRegisteredRuleType(taskType, createRegistered(), settings);
  });

  describe('what the detection rule types read of a process', () => {
    it('writes the rule execution events with their own event log provider', () => {
      expect(queryTaskType.eventLog?.providers.map(({ provider }) => provider)).toEqual(
        expect.arrayContaining(['alerting', 'securitySolution.ruleExecution'])
      );
    });

    it('reads the settings of the plugin, the rule registry and the alerting framework', () => {
      expect(queryTaskType.settings).toEqual(
        expect.arrayContaining(['alerting', 'actions', 'securitySolution', 'ruleRegistry'])
      );
    });

    it('declares the saved object types the executors read', () => {
      expect(queryTaskType.savedObjectTypes?.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'exception-list',
          'exception-list-agnostic',
          'query',
          'security:reference-data',
          'alert',
          'index-pattern',
        ])
      );
    });

    it('declares what the response actions read: Fleet, osquery and the endpoint saved objects', () => {
      expect(queryTaskType.savedObjectTypes?.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          'ingest-agent-policies',
          'ingest-package-policies',
          'osquery-saved-query',
          'security:reference-data',
        ])
      );
      expect(queryTaskType.encryptedSavedObjectTypes?.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['alert', 'ingest-outputs'])
      );
    });

    it('runs next to the security plugin of Core', () => {
      expect(queryTaskType.taskPlugins?.map(({ manifest }) => manifest.id)).toEqual([
        'security',
        'telemetry',
      ]);
    });

    it('registers the analytics events of the plugin in the process, which ships them', () => {
      expect(queryTaskType.analyticsEventTypes?.length).toBeGreaterThan(0);
    });

    it('declares the ml job saved object type for the ml rule', () => {
      expect(mlTaskType.savedObjectTypes?.map(({ name }) => name)).toContain('ml-job');
    });

    it('registers the ui settings the executors read', () => {
      const keys = (queryTaskType.uiSettings?.defaults ?? []).flatMap((defaults) =>
        Object.keys(defaults)
      );
      expect(keys).toEqual(
        expect.arrayContaining([
          'securitySolution:excludedDataTiersForRuleExecution',
          'securitySolution:includedDataStreamNamespacesForRuleExecution',
          'search:includeFrozen',
        ])
      );
    });

    it('keeps them when the module is built again with what plugins contribute', () => {
      const rebuilt = queryTaskType.contributions!.apply!({}) as typeof queryTaskType;
      expect(rebuilt.eventLog?.providers.map(({ provider }) => provider)).toContain(
        'securitySolution.ruleExecution'
      );
      expect(rebuilt.settings).toContain('securitySolution');
    });
  });
});
