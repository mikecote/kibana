/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginInitializer } from '@kbn/core/server';
import { PluginType } from '@kbn/core-base-common';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';
import type { TaskRegisterDefinition } from '../task_type_dictionary';
import { getTaskProcessContext } from './context';

/** What plugins of a task process get from Task Manager at setup. */
export interface TaskProcessTaskManagerSetup {
  /** Registers the definitions a task process serves, as `registerTaskDefinitions` does in Kibana. */
  registerTaskDefinitions: (definitions: Record<string, TaskRegisterDefinition>) => void;
}

const plugin: PluginInitializer<TaskProcessTaskManagerSetup, Record<string, never>> = async () => ({
  setup: () => ({
    registerTaskDefinitions: (definitions: Record<string, TaskRegisterDefinition>) => {
      const { definitions: registered } = getTaskProcessContext();
      for (const [type, definition] of Object.entries(definitions)) {
        if (registered.has(type)) throw new Error(`Task type ${type} is already registered`);
        registered.set(type, definition);
      }
    },
  }),
  start: () => ({}),
});

/**
 * Task Manager as a plugin of a task process: it collects the task definitions plugins register. It
 * claims, polls and schedules nothing, because Kibana does that and sends the process one run at a time.
 */
export const createTaskManagerStaticPlugin = (kibanaVersion: string): StaticPlugin => ({
  manifest: {
    id: 'taskManager',
    version: kibanaVersion,
    kibanaVersion,
    type: PluginType.standard,
    configPath: ['xpack', 'task_manager'],
    requiredPlugins: [],
    optionalPlugins: [],
    requiredBundles: [],
    runtimePluginDependencies: [],
    server: true,
    ui: false,
    owner: { name: 'Response Ops', githubTeam: 'response-ops' },
  },
  definition: { plugin },
});
