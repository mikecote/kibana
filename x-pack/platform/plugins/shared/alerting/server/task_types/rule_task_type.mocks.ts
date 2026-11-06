/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { configSchema } from '../config';
import type { RuleTaskTypeModule } from './rule_task_type';
import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import { normalizeRuleType } from '../lib/normalize_rule_type';
import type { UntypedRuleType } from '../types';

/** The part of a task host that builds a rule type: what a module file's factory may read. */
export const createRuleTypeHostMock = (settings: Record<string, unknown> = {}) => ({
  logger: loggingSystemMock.createLogger(),
  server: {
    uuid: 'test-uuid',
    version: '9.9.9',
    buildNum: 1,
    publicBaseUrl: 'https://kibana.test',
    isServerless: false,
  },
  settings: { alerting: configSchema.validate({}), ...settings },
});

const identity = (ruleType: UntypedNormalizedRuleType) => ({
  id: ruleType.id,
  name: ruleType.name,
  category: ruleType.category,
  producer: ruleType.producer,
  solution: ruleType.solution,
  priority: ruleType.priority,
  ruleTaskTimeout: ruleType.ruleTaskTimeout,
  minimumLicenseRequired: ruleType.minimumLicenseRequired,
  defaultActionGroupId: ruleType.defaultActionGroupId,
  actionGroups: ruleType.actionGroups,
  recoveryActionGroup: ruleType.recoveryActionGroup,
  doesSetRecoveryContext: ruleType.doesSetRecoveryContext,
  autoRecoverAlerts: ruleType.autoRecoverAlerts,
  cancelAlertsOnRuleTimeout: ruleType.cancelAlertsOnRuleTimeout,
  alerts: ruleType.alerts,
});

/**
 * Checks that a module file builds the rule type the owning plugin registers with Kibana: same
 * `alerting:<id>` task type, and the same definition once both are normalized for the same config.
 */
export const expectModuleToMatchRegisteredRuleType = (
  taskType: RuleTaskTypeModule,
  registered: unknown,
  settings: Record<string, unknown> = {}
) => {
  const host = createRuleTypeHostMock(settings);
  const fromKibana = normalizeRuleType(registered as UntypedRuleType, {
    config: host.settings.alerting as never,
    logger: host.logger,
  });
  const fromModule = taskType.buildRuleType(host as never);
  expect(taskType.type).toBe(`alerting:${fromKibana.id}`);
  expect(identity(fromModule)).toEqual(identity(fromKibana));
};
