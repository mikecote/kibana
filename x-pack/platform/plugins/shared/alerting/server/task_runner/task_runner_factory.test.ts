/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import sinon from 'sinon';
import { usageCountersServiceMock } from '@kbn/usage-collection-plugin/server/usage_counters/usage_counters_service.mock';
import type { ConcreteTaskInstance } from '@kbn/task-manager-plugin/server';
import { TaskStatus } from '@kbn/task-manager-plugin/server';
import { taskManagerMock } from '@kbn/task-manager-plugin/server/mocks';
import { TaskRunnerFactory } from './task_runner_factory';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import {
  loggingSystemMock,
  savedObjectsServiceMock,
  elasticsearchServiceMock,
  uiSettingsServiceMock,
} from '@kbn/core/server/mocks';
import { actionsMock } from '@kbn/actions-plugin/server/mocks';
import { eventLoggerMock } from '@kbn/event-log-plugin/server/event_logger.mock';
import { ruleTypeRegistryMock } from '../rule_type_registry.mock';
import { executionContextServiceMock } from '@kbn/core/server/mocks';
import { dataPluginMock } from '@kbn/data-plugin/server/mocks';
import { inMemoryMetricsMock } from '../monitoring/in_memory_metrics.mock';
import type { SharePluginStart } from '@kbn/share-plugin/server';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import { dataViewPluginMocks } from '@kbn/data-views-plugin/public/mocks';
import { alertsServiceMock } from '../alerts_service/alerts_service.mock';
import { ConnectorAdapterRegistry } from '../connector_adapters/connector_adapter_registry';
import type { TaskRunnerContext } from './types';
import { ApiKeyType } from './types';
import { backfillClientMock } from '../backfill_client/backfill_client.mock';
import { rulesSettingsServiceMock } from '../rules_settings/rules_settings_service.mock';
import { maintenanceWindowsServiceMock } from './maintenance_windows/maintenance_windows_service.mock';
import { eventLogClientMock } from '@kbn/event-log-plugin/server/mocks';

const inMemoryMetrics = inMemoryMetricsMock.create();
const backfillClient = backfillClientMock.create();
const rulesSettingsService = rulesSettingsServiceMock.create();
const maintenanceWindowsService = maintenanceWindowsServiceMock.create();
const executionContext = executionContextServiceMock.createSetupContract();
const mockUsageCountersSetup = usageCountersServiceMock.createSetupContract();
const mockUsageCounter = mockUsageCountersSetup.createUsageCounter('test');
const mockAlertService = alertsServiceMock.create();
const savedObjectsService = savedObjectsServiceMock.createInternalStartContract();
const uiSettingsService = uiSettingsServiceMock.createStartContract();
const elasticsearchService = elasticsearchServiceMock.createInternalStart();
const dataPlugin = dataPluginMock.createStartContract();
const dataViewsMock = {
  dataViewsServiceFactory: jest.fn().mockResolvedValue(dataViewPluginMocks.createStartContract()),
  getScriptedFieldsEnabled: jest.fn().mockReturnValue(true),
} as DataViewsServerPluginStart;
let fakeTimer: sinon.SinonFakeTimers;

describe('Task Runner Factory', () => {
  let mockedTaskInstance: ConcreteTaskInstance;

  beforeAll(() => {
    fakeTimer = sinon.useFakeTimers();
    mockedTaskInstance = {
      id: '',
      attempts: 0,
      status: TaskStatus.Running,
      version: '123',
      runAt: new Date(),
      scheduledAt: new Date(),
      startedAt: new Date(),
      retryAt: new Date(Date.now() + 5 * 60 * 1000),
      state: {
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
      },
      taskType: 'alerting:test',
      params: {
        alertId: '1',
      },
      ownerId: null,
    };
  });

  afterAll(() => fakeTimer.restore());

  const encryptedSavedObjectsPlugin = encryptedSavedObjectsMock.createStart();
  const connectorAdapterRegistry = new ConnectorAdapterRegistry();

  const taskRunnerFactoryInitializerParams: jest.Mocked<TaskRunnerContext> = {
    actionsConfigMap: { default: { max: 1000 } },
    actionsPlugin: actionsMock.createStart(),
    inMemoryMetrics,
    alertsService: mockAlertService,
    backfillClient,
    cancelAlertsOnRuleTimeout: true,
    connectorAdapterRegistry,
    data: dataPlugin,
    dataViews: dataViewsMock,
    elasticsearch: elasticsearchService,
    encryptedSavedObjectsClient: encryptedSavedObjectsPlugin.getClient(),
    eventLogger: eventLoggerMock.create(),
    executionContext,
    kibanaBaseUrl: 'https://localhost:5601',
    logger: loggingSystemMock.create().get(),
    maintenanceWindowsService,
    maxAlerts: 1000,
    ruleTypeRegistry: ruleTypeRegistryMock.create(),
    rulesSettingsService,
    savedObjects: savedObjectsService,
    share: {} as SharePluginStart,
    spaceIdToNamespace: jest.fn().mockReturnValue(undefined),
    uiSettings: uiSettingsService,
    usageCounter: mockUsageCounter,
    isServerless: false,
    getEventLogClient: jest.fn().mockReturnValue(eventLogClientMock.create()),
    apiKeyType: ApiKeyType.ES,
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  test(`throws an error if factory is initialized multiple times`, () => {
    const factory = new TaskRunnerFactory();
    factory.initialize(taskRunnerFactoryInitializerParams);
    expect(() =>
      factory.initialize(taskRunnerFactoryInitializerParams)
    ).toThrowErrorMatchingInlineSnapshot(`"TaskRunnerFactory already initialized"`);
  });

  test(`gives the runtime to whoever waits for it once the factory is initialized`, async () => {
    const factory = new TaskRunnerFactory();
    const runtime = factory.getRuntime();
    const settled = jest.fn();
    runtime.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    factory.initialize(taskRunnerFactoryInitializerParams);
    await expect(runtime).resolves.toBe(taskRunnerFactoryInitializerParams);
    await expect(factory.getRuntime()).resolves.toBe(taskRunnerFactoryInitializerParams);
  });

  test(`throws an error if createAdHoc is called when factory isn't initialized`, () => {
    const factory = new TaskRunnerFactory();
    expect(() =>
      factory.createAdHoc(taskManagerMock.createRunContext({ taskInstance: mockedTaskInstance }))
    ).toThrowErrorMatchingInlineSnapshot(`"TaskRunnerFactory not initialized"`);
  });
});
