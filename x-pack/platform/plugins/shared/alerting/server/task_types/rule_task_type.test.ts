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
import { createRuleTypeHostMock } from './rule_task_type.mocks';
import { createUnsupportedRuleTaskType } from './unsupported_rule_task_type';

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

    it('declares what a rule run needs from the host', () => {
      const taskType = createRuleTaskType({ ruleTypeId: 'test.rule', getRuleType });
      expect(taskType.settings).toEqual(['alerting', 'actions']);
      expect(taskType.taskManager).toBe(true);
      expect(taskType.licensing).toBe(true);
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

describe('createUnsupportedRuleTaskType', () => {
  it('declines every run, naming why', async () => {
    const taskType = createUnsupportedRuleTaskType('test.rule', 'it needs a plugin');
    expect(taskType.type).toBe('alerting:test.rule');
    const task = taskType.createTaskRunner(context, createTaskHostMock());
    await expect(task.run()).rejects.toMatchObject({
      name: 'DeclinedRunError',
      message: 'alerting:test.rule cannot run in a task process: it needs a plugin',
    });
  });

  it('needs nothing from the host', () => {
    const taskType = createUnsupportedRuleTaskType('test.rule', 'reason');
    expect(taskType.savedObjectTypes).toBeUndefined();
    expect(taskType.settings).toBeUndefined();
  });
});
