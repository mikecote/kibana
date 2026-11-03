/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ContainerModule } from 'inversify';
import { get } from 'lodash';
import { OnSetup, OnStart } from '@kbn/core-di';
import { createHeadlessCore } from '@kbn/core-task-host-server-internal';
import type { NeedsSpec, ServiceModule, TaskTypeModule } from './task_type';
import { createRunnerInScope } from './resolve_needs';
import type { PodTaskDefinition } from '../task_pod/host/server';

const VALIDATION_CONTEXT = { dev: false, prod: true, dist: true, serverless: false };

/**
 * Boots a headless host for one task type: Core's Elasticsearch client, the service modules the
 * type lists, and nothing else. No plugins, no plugin discovery, no HTTP server.
 */
export const bootUnit = async (
  unit: TaskTypeModule<NeedsSpec>,
  { config, logLevel }: { config: Record<string, unknown>; logLevel?: never }
) => {
  const core = await createHeadlessCore({ config, logLevel });
  const { container } = core;

  const loaded = new Set<ServiceModule>();
  const loadModule = (module: ServiceModule) => {
    if (loaded.has(module)) return;
    loaded.add(module);
    module.requires?.forEach(loadModule);
    if (module.config) {
      const { path, schema, token } = module.config;
      const validated = schema.validate(get(config, path, {}), VALIDATION_CONTEXT);
      container.bind(token).toConstantValue(validated);
    }
    container.load(new ContainerModule((options) => module.load(options)));
  };
  unit.modules?.forEach(loadModule);

  // Declarative registrations (saved object types, event log providers) run before saved objects
  // are created, as in Kibana's setup phase.
  for (const hook of container.getAll(OnSetup, { optional: true }) ?? []) hook(container);
  for (const hook of container.getAll(OnStart, { optional: true }) ?? []) hook(container);

  const definition: PodTaskDefinition = {
    createTaskRunner: (context) => {
      let task: Awaited<ReturnType<typeof createRunnerInScope>> | undefined;
      let cancelled = false;
      return {
        run: async () => {
          task = await createRunnerInScope(unit, container, context);
          if (cancelled) await task.cancel?.();
          return task.run();
        },
        cancel: async () => {
          cancelled = true;
          await task?.cancel?.();
        },
      };
    },
  };

  return {
    core,
    taskDefinitions: new Map([[unit.type, definition]]),
    stop: () => core.stop(),
  };
};
