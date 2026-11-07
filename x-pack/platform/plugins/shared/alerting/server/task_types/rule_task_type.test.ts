/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { TaskPriority } from '@kbn/task-manager-plugin/server/task';
import type { RunContext } from '@kbn/task-manager-plugin/server';
import { createTaskHostMock } from '@kbn/task-manager-plugin/server/task_type_module.mocks';
import { TaskRunner } from '../task_runner/task_runner';
import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import type { UntypedRuleType } from '../types';
import type { RuleRunRuntime } from '../task_runner/types';
import { createRuleTaskType } from './rule_task_type';
import { RULE_RUN_CONTRIBUTIONS } from './rule_run_contribution';
import { createRuleTypeHostMock } from './rule_task_type.mocks';

jest.mock('../task_runner/task_runner');

const baseRuleType = {
  id: 'test.rule',
  name: 'Test rule',
  actionGroups: [{ id: 'default', name: 'Default' }],
  defaultActionGroupId: 'default',
  recoveryActionGroup: { id: 'recovered', name: 'Recovered' },
  minimumLicenseRequired: 'basic',
  isExportable: true,
  executor: jest.fn(),
  category: 'test',
  producer: 'alerts',
  solution: 'stack',
  validate: { params: schema.any() },
  validLegacyConsumers: [],
} as unknown as UntypedNormalizedRuleType;

const context = {
  taskInstance: { id: 'rule-1', params: { alertId: 'rule-1', spaceId: 'default' } },
  executionUuid: 'uuid-1',
} as unknown as RunContext;

describe('createRuleTaskType', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('in Kibana', () => {
    const runtime = {
      inMemoryMetrics: {},
      savedObjects: { createInternalRepository: jest.fn().mockReturnValue('repository') },
    } as unknown as RuleRunRuntime;

    it('has the definition the rule type registry used to register', () => {
      const taskType = createRuleTaskType(
        {
          ruleType: {
            ...baseRuleType,
            priority: TaskPriority.Deferrable,
            ruleTaskTimeout: '20m',
          } as UntypedNormalizedRuleType,
        },
        { getRuntime: async () => runtime }
      );
      expect(taskType).toMatchObject({
        type: 'alerting:test.rule',
        title: 'Test rule',
        priority: TaskPriority.Deferrable,
        timeout: '20m',
        taskTypeGroup: 'alerting',
      });
      expect(taskType.paramsSchema).toBeDefined();
      expect(taskType.stateSchemaByVersion).toBeDefined();
    });

    it('adds the custom cost of the rule types that have one', () => {
      const taskType = createRuleTaskType(
        { ruleType: { ...baseRuleType, id: 'siem.indicatorRule' } as UntypedNormalizedRuleType },
        { getRuntime: async () => runtime }
      );
      expect(taskType.cost).toBeDefined();
    });

    it('declares nothing for a task process, which Kibana does not need', () => {
      const taskType = createRuleTaskType(
        { ruleType: baseRuleType },
        { getRuntime: async () => runtime }
      );
      expect(taskType.savedObjectTypes).toBeUndefined();
      expect(taskType.eventLog).toBeUndefined();
      expect(taskType.settings).toBeUndefined();
      expect(taskType.parity).toBeUndefined();
    });

    it('runs the task runner with the runtime of the plugin', async () => {
      const run = jest.fn().mockResolvedValue({ state: {} });
      (TaskRunner as unknown as jest.Mock).mockImplementation(() => ({ run, cancel: jest.fn() }));
      const taskType = createRuleTaskType(
        { ruleType: baseRuleType },
        { getRuntime: async () => runtime }
      );
      const task = taskType.createTaskRunner(context, createTaskHostMock());
      await expect(task.run()).resolves.toEqual({ state: {} });
      expect(TaskRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          context: runtime,
          ruleType: baseRuleType,
          executionUuid: 'uuid-1',
          internalSavedObjectsRepository: 'repository',
        })
      );
    });
  });

  describe('in a task process', () => {
    const getRuleType = jest.fn(() => ({ ...baseRuleType } as unknown as UntypedRuleType));

    it('is known by its id alone, without building the rule type', () => {
      const taskType = createRuleTaskType({ ruleTypeId: 'test.rule', getRuleType });
      expect(taskType.type).toBe('alerting:test.rule');
      expect(getRuleType).not.toHaveBeenCalled();
    });

    it('says which connector types and adapters the process registered, for Kibana to compare', async () => {
      const standalone = jest
        .spyOn(
          jest.requireActual('./standalone/create_standalone_rule_run_runtime'),
          'createStandaloneRuleRunRuntime'
        )
        .mockReturnValue({
          runtime: { alertsService: null },
          fieldFormats: {},
          getUnsupportedActionTypes: () => [],
          getRegisteredConnectorTypeIds: () => ['.email', '.slack'],
          getRegisteredConnectorAdapterIds: () => ['.cases'],
          stop: jest.fn(),
        } as never);
      const taskType = createRuleTaskType({ ruleTypeId: 'test.rule', getRuleType });
      const host = {
        ...createRuleTypeHostMock(),
        licensing: { license$: {} },
      } as never;
      const hooks = Object.fromEntries((taskType.parity ?? []).map((hook) => [hook.kind, hook]));
      expect(Object.keys(hooks).sort()).toEqual(['connectorAdapters', 'connectorTypes']);
      await expect(hooks.connectorTypes.getIds(host)).resolves.toEqual(['.email', '.slack']);
      await expect(hooks.connectorAdapters.getIds(host)).resolves.toEqual(['.cases']);
      // The runtime is built once for the process, however many things ask.
      expect(standalone).toHaveBeenCalledTimes(1);
      standalone.mockRestore();
    });

    describe('declining a rule before it has side effects', () => {
      const createStandalone = (ruleAttributes: Record<string, unknown>) =>
        jest
          .spyOn(
            jest.requireActual('./standalone/create_standalone_rule_run_runtime'),
            'createStandaloneRuleRunRuntime'
          )
          .mockReturnValue({
            runtime: {
              alertsService: null,
              spaceIdToNamespace: () => undefined,
              savedObjects: {
                createInternalRepository: () => ({
                  get: async () => ({ attributes: ruleAttributes }),
                }),
              },
            },
            fieldFormats: {},
            getUnsupportedActionTypes: () => [],
            getRegisteredConnectorTypeIds: () => [],
            getRegisteredConnectorAdapterIds: () => [],
            stop: jest.fn(),
          } as never);
      const host = { ...createRuleTypeHostMock(), licensing: { license$: {} } } as never;

      it('declines a rule that the module says it cannot serve, with the reason', async () => {
        const standalone = createStandalone({ params: { workflowConfig: {} } });
        const declineRun = jest.fn(({ ruleParams }) =>
          ruleParams.workflowConfig ? 'storage is not supported' : undefined
        );
        const taskType = createRuleTaskType(
          { ruleTypeId: 'test.rule', getRuleType },
          { declineRun }
        );
        const task = taskType.createTaskRunner(context, host);
        await expect(task.run()).rejects.toThrow(
          /Rule rule-1 cannot run in this task process: storage is not supported/
        );
        expect(declineRun).toHaveBeenCalledWith({
          settings: expect.objectContaining({ alerting: expect.anything() }),
          ruleParams: { workflowConfig: {} },
        });
        // Nothing ran: the task runner was never built.
        expect(TaskRunner).not.toHaveBeenCalled();
        standalone.mockRestore();
      });

      it('runs a rule the module can serve', async () => {
        const standalone = createStandalone({ params: {} });
        const run = jest.fn().mockResolvedValue({ state: {} });
        (TaskRunner as unknown as jest.Mock).mockImplementation(() => ({ run, cancel: jest.fn() }));
        const taskType = createRuleTaskType(
          { ruleTypeId: 'test.rule', getRuleType },
          { declineRun: () => undefined }
        );
        await expect(taskType.createTaskRunner(context, host).run()).resolves.toEqual({
          state: {},
        });
        standalone.mockRestore();
      });
    });

    it('declares required and optional plugin settings separately', () => {
      const taskType = createRuleTaskType(
        { ruleTypeId: 'test.rule', getRuleType },
        { optionalSettings: ['fleetPackageMetadata'] }
      );
      expect(taskType.settings).toEqual(['alerting', 'actions', 'security', 'alertingRun']);
      expect(taskType.optionalSettings).toEqual([
        'ruleDataViewsCapabilities',
        'spacesRuntime',
        'fleetPackageMetadata',
      ]);
      // The privileges of a connector are checked when a run enqueues it, as in Kibana.
      expect(taskType.taskPlugins?.map(({ manifest }) => manifest.id)).toEqual([
        'security',
        'telemetry',
      ]);
      expect(taskType.taskManager).toEqual({ schedulableTypes: [/^actions:/] });
      expect(taskType.licensing).toBe(true);
      // Usage a rule run counts is stored by the process, which also ships the events it reports.
      expect(taskType.usageCounters).toBe(true);
      expect(taskType.analyticsEventTypes).toEqual([]);
      expect(taskType.eventLog?.providers).toEqual([
        { provider: 'alerting', actions: expect.arrayContaining(['execute', 'execute-start']) },
      ]);
      expect(taskType.savedObjectTypes?.map((type) => type.name)).toEqual(
        expect.arrayContaining(['alert', 'rules-settings', 'action', 'action_task_params'])
      );
      expect(taskType.encryptedSavedObjectTypes?.map((type) => type.type).sort()).toEqual([
        'action',
        'action_task_params',
        'alert',
      ]);
    });

    it('declares the analytics events the executor reports, and those of the connectors it executes', () => {
      const event = { eventType: 'my_event', schema: {} };

      expect(
        createRuleTaskType(
          { ruleTypeId: 'test.rule', getRuleType },
          { analyticsEventTypes: [event] }
        ).analyticsEventTypes
      ).toEqual([event]);
      expect(
        createRuleTaskType(
          { ruleTypeId: 'test.rule', getRuleType },
          { analyticsEventTypes: [event], executeConnectors: true }
        ).analyticsEventTypes?.map(({ eventType }) => eventType)
      ).toEqual(expect.arrayContaining(['my_event', 'gen_ai_token_count']));
    });

    it('schedules the task types the rule type asks for besides actions', () => {
      const taskType = createRuleTaskType(
        { ruleTypeId: 'test.rule', getRuleType },
        { schedulableTaskTypes: [/^workflow:run$/] }
      );
      expect(taskType.taskManager).toEqual({
        schedulableTypes: [/^actions:/, /^workflow:run$/],
      });
    });

    it('is built again with what other plugins contribute to rule runs', () => {
      const taskType = createRuleTaskType({ ruleTypeId: 'test.rule', getRuleType });
      expect(taskType.contributions?.keys).toEqual([RULE_RUN_CONTRIBUTIONS]);

      const contributedType = { name: 'contributed-type', hidden: true } as never;
      const applied = taskType.contributions!.apply!({
        [RULE_RUN_CONTRIBUTIONS]: [{ declares: { savedObjectTypes: [contributedType] } }],
      });

      expect(applied.type).toBe('alerting:test.rule');
      expect(applied.savedObjectTypes).toContain(contributedType);
      expect(taskType.savedObjectTypes).not.toContain(contributedType);
    });

    it('builds the rule type the way Kibana normalizes it, from the host', () => {
      const taskType = createRuleTaskType({ ruleTypeId: 'test.rule', getRuleType });
      const host = createRuleTypeHostMock();
      const ruleType = taskType.buildRuleType(host as never);
      expect(getRuleType).toHaveBeenCalledWith(
        expect.objectContaining({
          isServerless: false,
          kibanaVersion: '9.9.9',
          publicBaseUrl: 'https://kibana.test',
          locators: expect.anything(),
        })
      );
      expect(ruleType.ruleTaskTimeout).toBe('5m');
      expect(ruleType.actionGroups.map((group) => group.id)).toEqual(
        expect.arrayContaining(['default', 'recovered'])
      );
    });

    it('refuses a factory that builds another rule type than the module declares', () => {
      const taskType = createRuleTaskType({
        ruleTypeId: 'declared.id',
        getRuleType: () => ({ ...baseRuleType } as unknown as UntypedRuleType),
      });
      expect(() => taskType.buildRuleType(createRuleTypeHostMock() as never)).toThrow(
        /declares rule type "declared.id" but its factory built "test.rule"/
      );
    });

    it('creates the locators the module lists for the factory to use', () => {
      const registerLocators = jest.fn();
      const taskType = createRuleTaskType(
        { ruleTypeId: 'test.rule', getRuleType },
        {
          locators: [
            { id: 'A_LOCATOR', getLocation: async () => ({ app: 'a', path: '/', state: {} }) },
          ],
          registerLocators,
        }
      );
      taskType.buildRuleType(createRuleTypeHostMock() as never);
      const deps = (getRuleType.mock.calls as unknown[][])[0][0] as {
        locators: { get: (id: string) => unknown };
      };
      expect(deps.locators.get('A_LOCATOR')).toBeDefined();
      expect(registerLocators).toHaveBeenCalledWith(deps.locators);
    });
  });
});
