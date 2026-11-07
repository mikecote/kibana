/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { BehaviorSubject } from 'rxjs';
import { coreMock } from '@kbn/core/server/mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID } from '../rule_data_views_settings';
import { dataViewsServiceFactory } from '@kbn/data-views-plugin/server/data_views_service_factory';
import { createStandaloneSearch } from '@kbn/data-plugin/server/search/standalone_search';
import { httpServerMock } from '@kbn/core-http-server-mocks';
import { createTaskHostMock } from '@kbn/task-manager-plugin/server/task_type_module.mocks';
import { MaintenanceWindowClientFactory } from '@kbn/maintenance-windows-plugin/server/maintenance_window_client_factory';
import { createRuleRunActions } from '@kbn/actions-plugin/server/task_types/rule_run_actions';
import { configSchema } from '../../config';
import { getRuleTypeFeatureUsageName } from '../../lib/get_rule_type_feature_usage_name';
import type { RuleRunContribution } from '../rule_run_contribution';
import { ALERTING_RUN_SETTINGS_ID } from '../rule_run_settings';
import type { AlertingRunSettings } from '../rule_run_settings';
import { createStandaloneRuleRunRuntime } from './create_standalone_rule_run_runtime';

jest.mock('@kbn/data-views-plugin/server/data_views_service_factory', () => ({
  dataViewsServiceFactory: jest.fn(() => jest.fn()),
}));
jest.mock('@kbn/data-plugin/server/search/standalone_search', () => ({
  createStandaloneSearch: jest.fn(() => ({})),
}));
jest.mock('@kbn/actions-plugin/server/task_types/rule_run_actions', () => ({
  createRuleRunActions: jest.fn(({ registerConnectorTypes }) => {
    registerConnectorTypes({}, {});
    return {
      actionsPlugin: {},
      hasActionType: () => true,
      getActionTypeIds: () => [],
      stop: jest.fn(),
    };
  }),
}));
jest.mock('@kbn/maintenance-windows-plugin/server/maintenance_window_client_factory');

const license = {
  isAvailable: true,
  type: 'platinum',
  check: () => ({ state: 'valid' }),
  hasAtLeast: () => true,
  getFeature: () => ({ isAvailable: true, isEnabled: true }),
};

const createHost = ({
  alertingRun,
  featureUsage = { notifyUsage: jest.fn() },
}: {
  alertingRun?: AlertingRunSettings;
  featureUsage?: { notifyUsage: jest.Mock };
} = {}) =>
  createTaskHostMock({
    settings: {
      alerting: configSchema.validate({ enableFrameworkAlerts: false }),
      actions: {},
      ...(alertingRun ? { [ALERTING_RUN_SETTINGS_ID]: alertingRun } : {}),
    },
    uiSettings: coreMock.createStart().uiSettings,
    licensing: { license$: new BehaviorSubject(license as never), featureUsage },
    security: { authc: { apiKeys: {} }, audit: {} } as never,
    encryptedSavedObjects: { getClient: jest.fn() } as never,
    eventLog: { getLogger: jest.fn() } as never,
    taskManager: {} as never,
  });

const build = (
  host: ReturnType<typeof createHost>,
  contributions: RuleRunContribution[] = [],
  ruleType = { id: 'test', name: 'Test rule', minimumLicenseRequired: 'platinum' } as never
) =>
  createStandaloneRuleRunRuntime({
    host,
    getRuleType: () => ruleType,
    urlService: {} as never,
    contributions,
  });

describe('createStandaloneRuleRunRuntime', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('license feature usage', () => {
    it('reports the use of a rule type that needs a license to the feature usage of the host', () => {
      const featureUsage = { notifyUsage: jest.fn() };
      const { runtime } = build(createHost({ featureUsage }));

      runtime.ruleTypeRegistry.ensureRuleTypeEnabled('test');

      expect(featureUsage.notifyUsage).toHaveBeenCalledWith(
        getRuleTypeFeatureUsageName('Test rule')
      );
    });

    it('gives the actions license state the same feature usage', () => {
      const featureUsage = { notifyUsage: jest.fn() };
      build(createHost({ featureUsage }));
      expect((createRuleRunActions as jest.Mock).mock.calls[0][0].featureUsage).toBe(featureUsage);
    });
  });

  describe('what Kibana sent of the plugins around alerting', () => {
    const run = (alertingRun?: AlertingRunSettings) => build(createHost({ alertingRun }));

    it('applies maintenance windows unless the plugin is disabled in Kibana', async () => {
      const window = {
        id: 'mw',
        events: [
          {
            gte: new Date(Date.now() - 1000).toISOString(),
            lte: new Date(Date.now() + 60000).toISOString(),
          },
        ],
      };
      const create = jest.fn().mockReturnValue({
        getActiveMaintenanceWindows: jest.fn().mockResolvedValue([window]),
      });
      (MaintenanceWindowClientFactory as jest.Mock).mockImplementation(() => ({
        initialize: jest.fn(),
        createWithoutAuthorization: create,
      }));
      const get = (service: ReturnType<typeof run>['runtime']['maintenanceWindowsService']) =>
        service.getMaintenanceWindows({
          request: httpServerMock.createKibanaRequest(),
          spaceId: 'default',
          ruleTypeCategory: 'management',
          eventLogger: { setMaintenanceWindowIds: jest.fn() } as never,
        });

      const withWindows = run({
        maintenanceWindowsEnabled: true,
        dataViews: { scriptedFieldsEnabled: true },
      });
      expect((await get(withWindows.runtime.maintenanceWindowsService)).maintenanceWindows).toEqual(
        [window]
      );

      create.mockClear();
      const without = run({
        maintenanceWindowsEnabled: false,
        dataViews: { scriptedFieldsEnabled: true },
      });
      expect((await get(without.runtime.maintenanceWindowsService)).maintenanceWindows).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    });

    it('uses the scripted fields, rollups and search config of Kibana', () => {
      const searchConfig = { sessions: { enabled: false } };
      run({
        maintenanceWindowsEnabled: true,
        dataViews: { scriptedFieldsEnabled: false },
        search: {
          searchConfig: searchConfig as never,
          elasticsearchTimeouts: { shardTimeout: 1, requestTimeout: 2 },
          rollupsEnabled: true,
        },
      });
      expect(dataViewsServiceFactory).toHaveBeenCalledWith(
        expect.objectContaining({ scriptedFieldsEnabled: false, rollupsEnabled: true })
      );
      expect(createStandaloneSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          searchConfig,
          elasticsearchTimeouts: { shardTimeout: 1, requestTimeout: 2 },
          rollupsEnabled: true,
          licensing: { getLicense: expect.any(Function) },
        })
      );
    });

    it('keeps the defaults when it was sent nothing', () => {
      run();
      expect(dataViewsServiceFactory).toHaveBeenCalledWith(
        expect.objectContaining({ scriptedFieldsEnabled: true, rollupsEnabled: false })
      );
    });

    it('lets searches read the license', async () => {
      run();
      const { licensing } = (createStandaloneSearch as jest.Mock).mock.calls[0][0];
      await expect(licensing.getLicense()).resolves.toBe(license);
    });

    it('uses native capabilities without Spaces when the dispatching plugin is disabled', async () => {
      const host = createHost();
      const security = securityMock.createStart();
      security.authz.mode.useRbacForRequest.mockReturnValue(false);
      host.plugins = { security };
      host.settings = {
        ...host.settings,
        [RULE_DATA_VIEWS_CAPABILITIES_SETTINGS_ID]: { features: [], spacesEnabled: false },
      };
      build(host);
      const { capabilities } = jest.mocked(dataViewsServiceFactory).mock.calls[0][0];
      await expect(
        capabilities.resolveCapabilities(httpServerMock.createKibanaRequest(), {
          capabilityPath: 'indexPatterns',
        })
      ).resolves.toMatchObject({
        indexPatterns: { save: true },
      });
    });

    it('fails capability resolution explicitly when dispatch feature settings are missing', async () => {
      run();
      const { capabilities } = jest.mocked(dataViewsServiceFactory).mock.calls[0][0];
      await expect(
        capabilities.resolveCapabilities(httpServerMock.createKibanaRequest(), {
          capabilityPath: 'indexPatterns',
        })
      ).rejects.toThrow('require current feature settings and native Security');
    });
  });

  describe('alert.status.changed events', () => {
    it('sends none without a contribution that provides a workflows client', () => {
      const { runtime } = build(createHost(), [
        {
          register: ({ alerting }) =>
            alerting.enableAlertStatusChanged({ isEnabled: async () => true }),
        },
      ]);
      expect(runtime.alertStatusChanged).toBeUndefined();
    });

    it('sends them with the client a contribution provides, for the opt-ins contributions register', async () => {
      const emitEvent = jest.fn().mockResolvedValue(undefined);
      const getWorkflowsClient = jest
        .fn()
        .mockResolvedValue({ isWorkflowsAvailable: true, emitEvent });
      const isEnabled = jest.fn().mockResolvedValue(true);
      const { runtime } = build(createHost(), [
        { register: ({ alerting }) => alerting.enableAlertStatusChanged({ isEnabled }) },
        { getWorkflowsClient },
      ]);
      const request = httpServerMock.createKibanaRequest();
      const payload = { rule: { id: 'r' }, alert: { id: 'a' } } as never;

      expect(runtime.alertStatusChanged!.hasOptIns()).toBe(true);
      await expect(runtime.alertStatusChanged!.isEnabled(request)).resolves.toBe(true);
      await runtime.alertStatusChanged!.emit({ events: [payload], request });

      expect(getWorkflowsClient).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ host: expect.anything() })
      );
      expect(emitEvent).toHaveBeenCalledWith('alerting.v1.alertStatusChanged', payload);
    });

    it('has no opt-ins, so a run builds nothing, until a contribution registers one', () => {
      const { runtime } = build(createHost(), [{ getWorkflowsClient: jest.fn() }]);
      expect(runtime.alertStatusChanged!.hasOptIns()).toBe(false);
    });
  });
});
