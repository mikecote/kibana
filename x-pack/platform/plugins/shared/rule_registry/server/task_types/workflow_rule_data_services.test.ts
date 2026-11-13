/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { configSchema as alertingConfigSchema } from '@kbn/alerting-plugin/server/config';
import { AlertsService } from '@kbn/alerting-plugin/server/alerts_service';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { config as ruleRegistryConfig } from '../config';
import { createWorkflowRuleDataService } from './workflow_rule_data_services';

jest.mock('@kbn/alerting-plugin/server/alerts_service', () => ({
  ...jest.requireActual('@kbn/alerting-plugin/server/alerts_service'),
  AlertsService: jest.fn(),
}));

const setup = () => {
  const core = coreMock.createStart();
  const cleanup: Array<() => Promise<void>> = [];
  const getCommonInitializationPromise = jest.fn().mockResolvedValue({ result: true });
  jest
    .mocked(AlertsService)
    .mockImplementation(() => ({ getCommonInitializationPromise } as never));
  const host: TaskHost = {
    logger: loggingSystemMock.createLogger(),
    server: { version: '9.9.9', uuid: 'server-1', buildNum: 1, isServerless: false },
    elasticsearch: core.elasticsearch.client,
    savedObjects: core.savedObjects,
    executionContext: core.executionContext,
    security: { ...core.security, fips: coreMock.createSetup().security.fips },
    http: core.http,
    analytics: core.analytics,
    settings: {
      alerting: alertingConfigSchema.validate({}),
      ruleRegistry: ruleRegistryConfig.schema.validate({ write: { enabled: false } }),
    },
    onRunEnd: (flusher: () => Promise<void>) => cleanup.push(flusher),
  };
  return { host, cleanup, getCommonInitializationPromise };
};

describe('workflow rule data services', () => {
  beforeEach(() => jest.clearAllMocks());

  it('waits for common alert resources before opening the rule data service', async () => {
    const { host, cleanup, getCommonInitializationPromise } = setup();
    const ready = Promise.withResolvers<{ result: boolean }>();
    getCommonInitializationPromise.mockReturnValue(ready.promise);
    let initialized = false;
    const pending = createWorkflowRuleDataService(host).then((service) => {
      initialized = true;
      return service;
    });
    await Promise.resolve();
    expect(initialized).toBe(false);
    ready.resolve({ result: true });
    expect((await pending).isWriteEnabled('security')).toBe(false);
    const constructorOptions = jest.mocked(AlertsService).mock.calls[0][0];
    const stopped = jest.fn();
    constructorOptions.pluginStop$.subscribe(stopped);
    await cleanup[0]();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('propagates alert resource initialization failures', async () => {
    const { host, getCommonInitializationPromise } = setup();
    getCommonInitializationPromise.mockResolvedValue({ result: false, error: 'mapping failed' });
    await expect(createWorkflowRuleDataService(host)).rejects.toThrow('mapping failed');
  });

  it('requires dispatch settings rather than constructing default configuration', async () => {
    const { host } = setup();
    await expect(createWorkflowRuleDataService({ ...host, settings: {} })).rejects.toThrow(
      'settings'
    );
  });
});
