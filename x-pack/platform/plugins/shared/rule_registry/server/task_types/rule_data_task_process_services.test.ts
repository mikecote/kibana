/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { configSchema as alertingConfigSchema } from '@kbn/alerting-plugin/server/config';
import { config as ruleRegistryConfig } from '../config';
import {
  createRuleDataTaskProcessService,
  RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID,
} from './rule_data_task_process_services';

const createDeps = (ruleRegistrySettings: unknown) => ({
  logger: loggingSystemMock.createLogger(),
  kibanaVersion: '9.9.9',
  isServerless: false,
  host: {} as never,
  runtime: undefined as never,
  settings: {
    alerting: alertingConfigSchema.validate({}),
    [RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID]: ruleRegistrySettings,
  },
});

describe('createRuleDataTaskProcessService', () => {
  it('builds the service from the settings Kibana sent, installing nothing while writes are disabled', () => {
    const deps = createDeps(ruleRegistryConfig.schema.validate({ write: { enabled: false } }));

    const service = createRuleDataTaskProcessService(deps);

    expect(service.isWriteEnabled('security')).toBe(false);
    expect(service.getResourcePrefix()).toBe('.alerts');
  });

  it('respects the contexts Kibana disabled', () => {
    const service = createRuleDataTaskProcessService(
      createDeps(
        ruleRegistryConfig.schema.validate({
          write: { enabled: false, disabledRegistrationContexts: ['security'] },
        })
      )
    );

    expect(service.isRegistrationContextDisabled('security')).toBe(true);
  });

  it('fails without the settings', () => {
    expect(() => createRuleDataTaskProcessService(createDeps(undefined))).toThrow(
      'was not given the settings of ruleRegistry'
    );
  });
});
