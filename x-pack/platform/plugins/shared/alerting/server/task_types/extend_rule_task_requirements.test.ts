/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';
import { schema } from '@kbn/config-schema';
import { createStandaloneEventLog } from '@kbn/event-log-plugin/server/standalone_event_log';
import { extendRuleTaskRequirements } from './extend_rule_task_requirements';

describe('extendRuleTaskRequirements', () => {
  const createModule = (type: string): TaskTypeModule => ({
    type,
    title: type,
    createTaskRunner: () => ({ run: async () => ({ state: {} }) }),
  });

  it('keeps the rule runner and identity and combines scheduling and config-dependent metadata', () => {
    const rule = createModule('alerting:test');
    rule.taskManager = { schedulableTypes: [/^actions:/] };
    rule.settings = ['actions'];
    rule.contributions = { keys: ['rules'], apply: jest.fn() };
    const native = createModule('workflow:run');
    native.taskManager = { schedulableTypes: [/^workflow:/] };
    native.settings = ['actions', 'workflowsExecutionEngine'];
    native.featureFlags = { 'workflows.native': false };
    native.contributions = { keys: ['rules', 'embeddables'] };
    native.licensing = true;
    native.usageCounters = true;
    native.createDataStreams = jest.fn().mockReturnValue([]);
    native.createSavedObjectTypes = jest.fn().mockReturnValue([]);
    const combined = extendRuleTaskRequirements(rule, native);
    expect(combined.type).toBe(rule.type);
    expect(combined.createTaskRunner).toBe(rule.createTaskRunner);
    expect(combined.contributions?.keys).toEqual(['rules', 'embeddables']);
    expect(combined.contributions?.apply).toBe(rule.contributions.apply);
    expect(combined.settings).toEqual(['actions', 'workflowsExecutionEngine']);
    expect(combined.taskManager).toEqual({ schedulableTypes: [/^actions:/, /^workflow:/] });
    expect(combined.licensing).toBe(true);
    expect(combined.usageCounters).toBe(true);
    expect(combined.featureFlags).toEqual({ 'workflows.native': false });
    const settings = { workflowsExecutionEngine: { enabled: true } };
    combined.createDataStreams?.(settings);
    expect(native.createDataStreams).toHaveBeenCalledWith(settings);
  });

  it('registers shared UI settings once while retaining native config-dependent settings', () => {
    const rule = createModule('alerting:test');
    const shared = { value: true, schema: schema.boolean() };
    const nativeSetting = { value: 1, schema: schema.number() };
    const dynamic = { value: 2, schema: schema.number() };
    const global = { value: false, schema: schema.boolean() };
    rule.uiSettings = { defaults: [{ shared }] };
    const native = createModule('workflow:run');
    native.uiSettings = { defaults: [{ shared, native: nativeSetting }] };
    native.registerUiSettings = (registry) => {
      registry.register({ shared, dynamic });
      registry.registerGlobal({ global });
    };
    const combined = extendRuleTaskRequirements(rule, native);
    expect(combined.uiSettings?.defaults).toEqual([{ shared }, { native: nativeSetting }]);
    const registry = { register: jest.fn(), registerGlobal: jest.fn() };
    combined.registerUiSettings?.(registry, {});
    expect(registry.register.mock.calls).toEqual([[{ dynamic }]]);
    expect(registry.registerGlobal.mock.calls).toEqual([[{ global }]]);
    registry.register.mockClear();
    registry.registerGlobal.mockClear();
    combined.registerUiSettings?.(registry, {});
    expect(registry.register.mock.calls).toEqual([[{ dynamic }]]);
    expect(registry.registerGlobal.mock.calls).toEqual([[{ global }]]);
  });

  it('combines shared event-log providers without registering a provider twice', () => {
    const rule = createModule('alerting:test');
    rule.eventLog = {
      create: createStandaloneEventLog,
      providers: [{ provider: 'actions', actions: ['execute', 'execute-start'] }],
    };
    const native = createModule('workflow:run');
    native.eventLog = {
      create: createStandaloneEventLog,
      providers: [
        { provider: 'actions', actions: ['execute', 'execute-failure'] },
        { provider: 'workflows', actions: ['run'] },
      ],
    };
    expect(extendRuleTaskRequirements(rule, native).eventLog?.providers).toEqual([
      { provider: 'actions', actions: ['execute', 'execute-start', 'execute-failure'] },
      { provider: 'workflows', actions: ['run'] },
    ]);
  });

  it('registers shared workflow data streams once across static and factory declarations', () => {
    const definition = {
      name: '.workflow-executions',
      version: 1,
      template: { mappings: { properties: { '@timestamp': { type: 'date' as const } } } },
    };
    const rule = createModule('alerting:test');
    const native = createModule('workflow:run');
    rule.createDataStreams = () => [{ ...definition }];
    native.createDataStreams = () => [{ ...definition }];
    expect(extendRuleTaskRequirements(rule, native).createDataStreams?.({})).toEqual([definition]);
    rule.dataStreams = [{ ...definition }];
    native.dataStreams = [{ ...definition }];
    const combined = extendRuleTaskRequirements(rule, native);
    expect(combined.dataStreams).toEqual([definition]);
    expect(combined.createDataStreams?.({})).toEqual([]);
  });
});
