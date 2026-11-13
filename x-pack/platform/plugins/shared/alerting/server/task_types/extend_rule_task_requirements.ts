/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskTypeModule } from '@kbn/task-manager-plugin/server/task_type_module';

/** Adds a native runtime's declared capabilities while preserving the rule's identity and runner. */
export const extendRuleTaskRequirements = (
  rule: TaskTypeModule,
  runtime: TaskTypeModule
): TaskTypeModule => {
  const modules = [rule, runtime];
  const defaults = new Set<string>();
  const globalDefaults = new Set<string>();
  const plugins = new Set<string>();
  const filterSettings = (
    settings: NonNullable<TaskTypeModule['uiSettings']>['defaults'],
    seen: Set<string>
  ) =>
    (settings ?? [])
      .map((group) =>
        Object.fromEntries(Object.entries(group).filter(([key]) => !seen.has(key) && seen.add(key)))
      )
      .filter((group) => Object.keys(group).length > 0);
  const eventLog = rule.eventLog ?? runtime.eventLog;
  const dataStreams = modules.flatMap((module) => module.dataStreams ?? []);
  const uniqueDataStreams = (definitions: NonNullable<TaskTypeModule['dataStreams']>) => [
    ...new Map(definitions.map((definition) => [definition.name, definition])).values(),
  ];
  const providers = new Map<string, Set<string>>();
  for (const module of modules) {
    for (const { provider, actions } of module.eventLog?.providers ?? []) {
      const registered = providers.get(provider) ?? new Set<string>();
      for (const action of actions) registered.add(action);
      providers.set(provider, registered);
    }
  }
  return {
    ...rule,
    contributions: {
      ...rule.contributions,
      keys: [...new Set(modules.flatMap((module) => module.contributions?.keys ?? []))],
    },
    savedObjectTypes: modules.flatMap((module) => module.savedObjectTypes ?? []),
    createSavedObjectTypes: (encryption, settings) =>
      modules.flatMap((module) => module.createSavedObjectTypes?.(encryption, settings) ?? []),
    encryptedSavedObjectTypes: modules.flatMap((module) => module.encryptedSavedObjectTypes ?? []),
    dataStreams: uniqueDataStreams(dataStreams),
    createDataStreams: (settings) => {
      const staticNames = new Set(dataStreams.map(({ name }) => name));
      return uniqueDataStreams(
        modules.flatMap((module) => module.createDataStreams?.(settings) ?? [])
      ).filter(({ name }) => !staticNames.has(name));
    },
    settings: [...new Set(modules.flatMap((module) => module.settings ?? []))],
    optionalSettings: [...new Set(modules.flatMap((module) => module.optionalSettings ?? []))],
    featureFlags: Object.assign({}, runtime.featureFlags, rule.featureFlags),
    licensing: rule.licensing ?? runtime.licensing,
    usageCounters: rule.usageCounters ?? runtime.usageCounters,
    taskManager: {
      schedulableTypes: modules.flatMap(({ taskManager }) =>
        typeof taskManager === 'object' ? taskManager.schedulableTypes ?? [] : []
      ),
    },
    taskPlugins: modules
      .flatMap((module) => module.taskPlugins ?? [])
      .filter(({ manifest }) => !plugins.has(manifest.id) && plugins.add(manifest.id)),
    uiSettings: {
      defaults: modules.flatMap((module) => filterSettings(module.uiSettings?.defaults, defaults)),
      globalDefaults: modules.flatMap((module) =>
        filterSettings(module.uiSettings?.globalDefaults, globalDefaults)
      ),
    },
    registerUiSettings: (registry, settings) => {
      const registeredDefaults = new Set(defaults);
      const registeredGlobalDefaults = new Set(globalDefaults);
      const registration: Parameters<NonNullable<TaskTypeModule['registerUiSettings']>>[0] = {
        register: (group) => {
          for (const filtered of filterSettings([group], registeredDefaults))
            registry.register(filtered);
        },
        registerGlobal: (group) => {
          for (const filtered of filterSettings([group], registeredGlobalDefaults))
            registry.registerGlobal(filtered);
        },
      };
      for (const module of modules) module.registerUiSettings?.(registration, settings);
    },
    analyticsEventTypes: modules.flatMap((module) => module.analyticsEventTypes ?? []),
    registerAnalyticsEventTypes: (analytics) => {
      for (const module of modules) module.registerAnalyticsEventTypes?.(analytics);
    },
    ...(eventLog
      ? {
          eventLog: {
            ...eventLog,
            providers: [...providers].map(([provider, actions]) => ({
              provider,
              actions: [...actions],
            })),
          },
        }
      : {}),
    parity: modules.flatMap((module) => module.parity ?? []),
  };
};
