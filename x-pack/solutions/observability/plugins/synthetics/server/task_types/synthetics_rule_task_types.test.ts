/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { getRuleTypeFromRegistration } from '@kbn/alerting-plugin/server/task_types/capture_rule_type';
import { expectModuleToMatchRegisteredRuleType } from '@kbn/alerting-plugin/server/task_types/rule_task_type.mocks';
import { registerSyntheticsStatusCheckRule } from '../alert_rules/status_rule/monitor_status_rule';
import { registerSyntheticsTLSCheckRule } from '../alert_rules/tls_rule/tls_rule';
import type { SyntheticsTaskProcessSettings } from '../alert_rules/rule_dependencies';
import { taskType as monitorStatus } from './monitor_status.task';
import { taskType as tls } from './tls.task';

describe('synthetics task type modules', () => {
  const synthetics: SyntheticsTaskProcessSettings = {
    service: { manifestUrl: 'https://manifest.test' },
    isCpsEnabled: false,
  };
  const observability = { unsafe: { alertDetails: { uptime: { enabled: true } } } };

  it.each([
    ['monitor status', monitorStatus, registerSyntheticsStatusCheckRule],
    ['TLS', tls, registerSyntheticsTLSCheckRule],
  ])('builds the %s rule type that the plugin registers', (_name, taskType, register) => {
    const registered = getRuleTypeFromRegistration((alerting) =>
      register(
        { logger: {}, basePath: {}, encryptedSavedObjects: {} } as never,
        {
          alerting,
          observability: { getAlertDetailsConfig: () => observability.unsafe.alertDetails },
        } as never,
        {} as never
      )
    );
    expectModuleToMatchRegisteredRuleType(taskType, registered, { synthetics, observability });
  });

  it('reads the monitors and the private locations, and no service API key of the plugin', () => {
    const types = monitorStatus.createSavedObjectTypes?.(
      encryptedSavedObjectsMock.createSetup(),
      {}
    );
    expect(types?.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'synthetics-monitor-multi-space',
        'synthetics-monitor',
        'synthetics-privates-locations',
      ])
    );
    expect(types?.map(({ name }) => name)).not.toContain('synthetics-service-api-key');
  });
});
