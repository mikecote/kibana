/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PluginWrapper } from './plugin';
import type {
  TaskCoreSetup,
  TaskCoreStart,
  TaskCoreSetupServices,
  TaskCoreStartServices,
} from './task_plugin';

export const createTaskPluginSetupContext = <
  TSetup,
  TStart,
  TPluginsSetup extends object,
  TPluginsStart extends object
>(
  deps: TaskCoreSetupServices,
  plugin: PluginWrapper<TSetup, TStart, TPluginsSetup, TPluginsStart>
): TaskCoreSetup<TPluginsStart, TStart> => ({
  analytics: deps.analytics,
  elasticsearch: {
    legacy: deps.elasticsearch.legacy,
    publicBaseUrl: deps.elasticsearch.publicBaseUrl,
    setUnauthorizedErrorHandler: deps.elasticsearch.setUnauthorizedErrorHandler,
  },
  logging: {
    configure: (config$) => deps.logging.configure(['plugins', plugin.name], config$),
  },
  savedObjects: deps.savedObjects,
  uiSettings: deps.uiSettings,
  dataStreams: deps.dataStreams,
  security: {
    registerSecurityDelegate: deps.security.registerSecurityDelegate,
    acquireFakeRequestEnricher: deps.security.acquireFakeRequestEnricher,
    fips: deps.security.fips,
    serviceAccounts: {
      registerWorkloadType: (registration) =>
        deps.security.serviceAccounts.registerWorkloadType(plugin.name, registration),
    },
  },
  userProfile: deps.userProfile,
  status: {
    set: deps.status.plugins.set.bind(null, plugin.name),
    derivedStatus$: deps.status.plugins.getDerivedStatus$(plugin.name),
  },
  getStartServices: () => plugin.taskStartDependencies,
});

export const createTaskPluginStartContext = (
  deps: TaskCoreStartServices,
  plugin: Pick<PluginWrapper, 'name'>
): TaskCoreStart => ({
  analytics: deps.analytics,
  elasticsearch: deps.elasticsearch,
  executionContext: deps.executionContext,
  savedObjects: deps.savedObjects,
  uiSettings: deps.uiSettings,
  dataStreams: deps.dataStreams,
  http: deps.http,
  security: {
    authc: deps.security.authc,
    audit: deps.security.audit,
    serviceAccounts: deps.security.serviceAccounts.asScopedToPlugin(plugin.name),
  },
  userProfile: deps.userProfile,
});
