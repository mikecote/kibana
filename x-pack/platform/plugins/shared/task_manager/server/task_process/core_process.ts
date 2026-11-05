/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { BehaviorSubject } from 'rxjs';
import { Env } from '@kbn/config';
import { PluginType } from '@kbn/core-base-common';
import { Root } from '@kbn/core-root-server-internal';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';
import {
  config as esoConfig,
  plugin as esoPlugin,
} from '@kbn/encrypted-saved-objects-plugin/server';
import { buildCoreConfig } from './core_config';
import { setTaskProcessContext } from './context';
import type { TaskProcessContext } from './context';
import { createTaskManagerStaticPlugin } from './task_manager_task_plugin';
import { createModuleStaticPlugin } from './module_plugin';
import type { TaskProcessInit } from './wire';
import type { TaskHost, TaskTypeModule } from '../task_type_module';
import type { TaskRegisterDefinition } from '../task_type_dictionary';

/**
 * The plugins a task process runs besides Core: Task Manager (it collects the task definitions),
 * the encrypted saved objects plugin when the module needs it, and the module itself.
 */
const getStaticPlugins = (module: TaskTypeModule, kibanaVersion: string): StaticPlugin[] => {
  const plugins: StaticPlugin[] = [createTaskManagerStaticPlugin(kibanaVersion)];
  if (module.encryptedSavedObjectTypes?.length) {
    plugins.push({
      manifest: {
        id: 'encryptedSavedObjects',
        version: kibanaVersion,
        kibanaVersion,
        type: PluginType.standard,
        configPath: ['xpack', 'encryptedSavedObjects'],
        requiredPlugins: [],
        optionalPlugins: [],
        requiredBundles: [],
        runtimePluginDependencies: [],
        server: true,
        ui: false,
        owner: { name: 'Kibana Security', githubTeam: 'kibana-security' },
      },
      definition: { config: esoConfig, plugin: esoPlugin as never },
    });
  }
  plugins.push(createModuleStaticPlugin(kibanaVersion));
  return plugins;
};

export interface TaskProcessCore {
  /** The task definitions plugins registered, which the process serves. */
  definitions: Map<string, TaskRegisterDefinition>;
  /** What the module's runner gets, which is also how a test seeds data the way a run reads it. */
  host: TaskHost;
  logger: ReturnType<Root['logger']['get']>;
  stop: () => Promise<void>;
}

/**
 * Starts Core, and the plugins a task type needs, in this process: the same boot a task process does,
 * without serving runs. Only one at a time, since plugins read what the process was started with.
 */
export const startTaskProcessCore = async ({
  init,
  module,
  contributions = {},
}: {
  init: TaskProcessInit;
  module: TaskTypeModule;
  contributions?: Record<string, unknown[]>;
}): Promise<TaskProcessCore> => {
  const definitions = new Map<string, TaskRegisterDefinition>();
  // The module with what plugins contributed to it declared: saved object types and the like.
  const applied = module.contributions?.apply?.(contributions) ?? module;
  const context: TaskProcessContext = { init, module: applied, contributions, definitions };
  setTaskProcessContext(context);

  const { settings, cleanup } = buildCoreConfig(init, applied);
  const isDev = init.server?.isDev ?? false;
  const buildNum = init.server?.buildNum ?? Number.MAX_SAFE_INTEGER;
  const env = Env.createDefault(
    process.cwd(),
    {
      configs: [],
      cliArgs: {
        dev: isDev,
        watch: false,
        basePath: false,
        runExamples: false,
        disableOptimizer: true,
        cache: false,
        dist: !isDev,
        oss: false,
        serverless: init.server?.isServerless,
      },
      repoPackages: [],
    },
    {
      branch: 'task-process',
      version: init.kibanaVersion,
      build: {
        number: buildNum,
        sha: 'task-process',
        date: new Date().toISOString(),
        distributable: !isDev,
      },
    }
  );
  const root = new Root({ getConfig$: () => new BehaviorSubject(settings) }, env, undefined, {
    staticPlugins: getStaticPlugins(applied, init.kibanaVersion),
  });
  await root.preboot();
  await root.setup();
  await root.start();

  return {
    definitions,
    host: (await context.host)!,
    logger: root.logger.get('task-process'),
    stop: async () => {
      await root.shutdown();
      cleanup();
    },
  };
};
