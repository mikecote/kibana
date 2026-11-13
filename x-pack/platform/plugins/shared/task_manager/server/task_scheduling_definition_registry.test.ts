/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { omit } from 'lodash';
import { TaskPriority } from './task';
import type { TaskInstance } from './task';
import { sanitizeTaskDefinitions } from './task_type_dictionary';
import { TaskSchedulingDefinitions } from './task_scheduling_definition_registry';
import { TaskValidator } from './task_validator';
import { createTaskSchedulingSnapshot } from './task_scheduling_snapshot';

const definition = {
  title: 'Native task metadata',
  paramsSchema: schema.object({ workflowId: schema.string() }),
  priority: TaskPriority.UserInteractive,
  allowPriorityOverride: true,
};

describe('native scheduling task metadata', () => {
  it('preserves native defaults, schema identity and priority without a runner', () => {
    const registry = new TaskSchedulingDefinitions();
    const runtimeDefinition = {
      ...definition,
      createTaskRunner: jest.fn(),
      observeRemoteRun: jest.fn(),
      taskPlugins: [],
    };
    registry.registerTaskDefinitions({ native: runtimeDefinition });
    expect(registry.get('native')).not.toHaveProperty('createTaskRunner');
    expect(registry.get('native')).not.toHaveProperty('observeRemoteRun');
    expect(registry.get('native')).not.toHaveProperty('taskPlugins');
    const [native] = sanitizeTaskDefinitions({
      native: { ...definition, createTaskRunner: () => ({ run: async () => undefined }) },
    });
    expect(registry.get('native')).toEqual(omit(native, ['createTaskRunner']));
    expect(registry.get('native')?.paramsSchema).toBe(definition.paramsSchema);
    expect(registry.getAllTypes()).toEqual(['native']);
    expect(registry.size()).toBe(1);
    expect(() => registry.ensureHas('missing')).toThrow('Unsupported task type "missing"');
  });

  it.each(['invalid,type', 'sampleTaskRemovedType'])(
    'applies native registration policy to %s',
    (type) => {
      const registry = new TaskSchedulingDefinitions();
      expect(() => registry.registerTaskDefinitions({ [type]: definition })).toThrow();
      expect(registry.size()).toBe(0);
    }
  );

  it('rejects duplicates, unsupported concurrency and invalid native timeouts', () => {
    const registry = new TaskSchedulingDefinitions();
    registry.registerTaskDefinitions({ native: definition });
    expect(() => registry.registerTaskDefinitions({ native: definition })).toThrow(
      'already defined'
    );
    expect(() => registry.registerTaskDefinitions({ other: { maxConcurrency: 2 } })).toThrow(
      "maxConcurrency setting isn't allowed"
    );
    expect(() => registry.registerTaskDefinitions({ other: { timeout: 'invalid' } })).toThrow(
      'Invalid timeout'
    );
    expect(registry.size()).toBe(1);
  });

  it('keeps native service-account workload policy without an execution callback', () => {
    const registry = new TaskSchedulingDefinitions();
    registry.registerTaskDefinitions({ native: { runAs: { workloadTypes: ['workflow'] } } });
    expect(registry.get('native')?.runAs).toEqual({ workloadTypes: ['workflow'] });
    expect(() =>
      registry.registerTaskDefinitions({
        reserved: { runAs: { workloadTypes: ['task_identity'] } },
      })
    ).toThrow('reserved for Task Manager');
  });

  it('round-trips captured metadata while requiring native owner schemas', () => {
    const native = new TaskSchedulingDefinitions();
    const schemas = {
      paramsSchema: schema.object({ workflowId: schema.string() }),
      stateSchemaByVersion: {
        1: {
          schema: schema.object({ count: schema.number() }),
          up: (state: TaskInstance['state']) => state,
        },
      },
    };
    native.registerTaskDefinitions({
      native: { ...definition, ...schemas, runAs: { workloadTypes: ['workflow'] } },
    });
    const snapshot = createTaskSchedulingSnapshot(native);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot[0]).toMatchObject({ paramsSchemaRequired: true, stateSchemaVersions: [1] });
    const unavailable = new TaskSchedulingDefinitions(snapshot);
    expect(() => createTaskSchedulingSnapshot(unavailable)).toThrow(
      'Native scheduling schemas are not available'
    );
    expect(() => unavailable.get('native')).toThrow('Native scheduling schemas are not available');
    expect(() => unavailable.ensureHas('native')).toThrow(
      'Native scheduling schemas are not available'
    );
    const restored = new TaskSchedulingDefinitions(snapshot, { native: schemas });
    expect(restored.get('native')?.paramsSchema).toBe(schemas.paramsSchema);
    expect(restored.get('native')?.stateSchemaByVersion?.[1].up).toBe(
      schemas.stateSchemaByVersion[1].up
    );
    expect(restored.get('native')?.runAs).toEqual({ workloadTypes: ['workflow'] });
  });

  it('runs the native state validator and migrations directly over metadata', () => {
    const registry = new TaskSchedulingDefinitions();
    const up = jest.fn((state: TaskInstance['state']) => ({ count: Number(state.count) + 1 }));
    registry.registerTaskDefinitions({
      native: {
        stateSchemaByVersion: {
          1: { schema: schema.object({ count: schema.number() }), up: (state) => state },
          2: { schema: schema.object({ count: schema.number() }), up },
        },
      },
    });
    const validator = new TaskValidator({
      definitions: registry,
      logger: loggingSystemMock.createLogger(),
      allowReadingInvalidState: false,
    });
    expect(
      validator.getValidatedTaskInstanceFromReading({
        taskType: 'native',
        state: { count: 1 },
        stateVersion: 1,
        params: {},
      })
    ).toMatchObject({ state: { count: 2 } });
    expect(up).toHaveBeenCalledWith({ count: 1 });
    expect(
      validator.getValidatedTaskInstanceForUpdating({
        taskType: 'native',
        state: { count: 3 },
        params: {},
      })
    ).toMatchObject({ stateVersion: 2, state: { count: 3 } });
    expect(() =>
      validator.getValidatedTaskInstanceForUpdating({
        taskType: 'native',
        state: { count: 'bad' },
        params: {},
      })
    ).toThrow();
  });
});
