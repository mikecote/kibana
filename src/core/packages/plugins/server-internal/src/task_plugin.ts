/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CoreSetup, CoreStart } from '@kbn/core-lifecycle-server';
import type { InternalCoreSetup, InternalCoreStart } from '@kbn/core-lifecycle-server-internal';
import type { PluginInitializerContext } from '@kbn/core-plugins-server';
import type { StaticPlugin } from './plugins_service';

export type TaskStaticPlugin = Omit<StaticPlugin, 'definition'> & {
  definition: StaticPlugin['definition'] &
    Required<Pick<StaticPlugin['definition'], 'taskPlugin'>> & {
      plugin?: never;
      module?: never;
    };
};

export type TaskCoreStart = Pick<
  CoreStart,
  | 'analytics'
  | 'elasticsearch'
  | 'executionContext'
  | 'savedObjects'
  | 'uiSettings'
  | 'security'
  | 'userProfile'
> & {
  http: Pick<CoreStart['http'], 'basePath' | 'getServerInfo' | 'selfClient'>;
};

export type TaskCoreSetup<TPluginsStart extends object = object, TStart = unknown> = Pick<
  CoreSetup,
  | 'analytics'
  | 'elasticsearch'
  | 'logging'
  | 'savedObjects'
  | 'uiSettings'
  | 'security'
  | 'userProfile'
> & {
  status: Pick<CoreSetup['status'], 'set' | 'derivedStatus$'>;
  getStartServices: () => Promise<[TaskCoreStart, TPluginsStart, TStart | undefined]>;
};

export type TaskCoreSetupServices = Pick<
  InternalCoreSetup,
  | 'analytics'
  | 'elasticsearch'
  | 'logging'
  | 'savedObjects'
  | 'uiSettings'
  | 'security'
  | 'userProfile'
  | 'status'
>;

export type TaskCoreStartServices = Pick<
  InternalCoreStart,
  | 'analytics'
  | 'elasticsearch'
  | 'executionContext'
  | 'savedObjects'
  | 'uiSettings'
  | 'security'
  | 'userProfile'
> & {
  http: Pick<InternalCoreStart['http'], 'basePath' | 'getServerInfo' | 'selfClient'>;
};

export interface TaskPlugin<
  TSetup = void,
  TStart = void,
  TPluginsSetup extends object = object,
  TPluginsStart extends object = object
> {
  setup(
    core: TaskCoreSetup<TPluginsStart, TStart>,
    plugins: TPluginsSetup
  ): TSetup | Promise<TSetup>;
  start(core: TaskCoreStart, plugins: TPluginsStart): TStart | Promise<TStart>;
  stop?(): void | Promise<void>;
}

export type TaskPluginInitializer<
  TSetup = void,
  TStart = void,
  TPluginsSetup extends object = object,
  TPluginsStart extends object = object
> = (
  context: PluginInitializerContext
) =>
  | TaskPlugin<TSetup, TStart, TPluginsSetup, TPluginsStart>
  | Promise<TaskPlugin<TSetup, TStart, TPluginsSetup, TPluginsStart>>;
