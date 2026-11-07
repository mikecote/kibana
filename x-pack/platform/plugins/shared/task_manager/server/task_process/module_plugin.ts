/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  TaskCoreSetup as CoreSetup,
  TaskCoreStart as CoreStart,
  TaskPluginInitializer,
} from '@kbn/core-plugins-server-internal';
import { PluginType } from '@kbn/core-base-common';
import type { TaskStaticPlugin } from '@kbn/core-plugins-server-internal';
import type {
  EncryptedSavedObjectsPluginSetup,
  EncryptedSavedObjectsPluginStart,
} from '@kbn/encrypted-saved-objects-plugin/server';
import type { SavedObjectsType } from '@kbn/core-saved-objects-server';
import {
  FEATURE_USAGE_SAVED_OBJECT_TYPE,
  featureUsageSavedObjectType,
} from '@kbn/licensing-plugin/server/services/feature_usage_store';
import { setupSavedObjects as registerTaskManagerSavedObjects } from '../saved_objects';
import { toTaskDefinition } from '../task_type_module';
import type { TaskHost } from '../task_type_module';
import { createHostTaskScheduling } from './host_capabilities/task_scheduling';
import {
  createStandaloneFeatureUsage,
  createStandaloneLicensing,
} from './host_capabilities/licensing';
import { createStandaloneUsageCounters } from './host_capabilities/usage_counters';
import type { StandaloneUsageCounters } from './host_capabilities/usage_counters';
import { reviveSettingsByPlugin } from './settings';
import { StandaloneSpacesExtension } from './spaces_extension';
import { getTaskProcessContext } from './context';
import { createHostFeatureFlags } from './run_context';
import { registerTaskAnalyticsEventTypes } from './host_capabilities/analytics';
import { createParityGuard } from './parity';
import type { TaskProcessTaskManagerSetup } from './task_manager_task_plugin';

interface SetupDeps {
  taskManager: TaskProcessTaskManagerSetup;
  encryptedSavedObjects?: EncryptedSavedObjectsPluginSetup;
}

interface StartDeps {
  encryptedSavedObjects?: EncryptedSavedObjectsPluginStart;
  [pluginId: string]: unknown;
}

/**
 * The task type module a process serves, as a plugin: what the module declares is registered with
 * Core and the plugins of the process at setup, exactly as a plugin registers its saved object types,
 * ui settings and encrypted saved objects in Kibana. The module's runner gets its `TaskHost` from
 * Core's start contract, so a run uses Core's own services.
 */
const plugin: TaskPluginInitializer<void, void, SetupDeps, StartDeps> = async (
  initializerContext
) => {
  const context = getTaskProcessContext();
  const { module, init } = context;
  const logger = initializerContext.logger.get('task-process');
  const stops: Array<() => Promise<void>> = [];

  let resolveHost!: (host: TaskHost) => void;
  const hostPromise = new Promise<TaskHost>((resolve) => (resolveHost = resolve));
  context.host = hostPromise;
  let fips: CoreSetup['security']['fips'] | undefined;
  let encryption: EncryptedSavedObjectsPluginSetup | undefined;
  let usageCounters: StandaloneUsageCounters | undefined;

  return {
    setup(core: CoreSetup, deps: SetupDeps) {
      fips = core.security.fips;
      const types: SavedObjectsType[] = [];
      const seen = new Set<string>();
      for (const type of module.savedObjectTypes ?? []) {
        if (seen.has(type.name)) continue;
        seen.add(type.name);
        types.push(type);
      }
      types.forEach((type) => core.savedObjects.registerType(type));
      for (const definition of new Set(module.dataStreams ?? [])) {
        core.dataStreams.registerDataStream(definition);
      }
      // The `task` type and its neighbours, which `host.taskManager` writes.
      if (module.taskManager) registerTaskManagerSavedObjects(core.savedObjects);

      if (module.encryptedSavedObjectTypes?.length) {
        if (!deps.encryptedSavedObjects) {
          throw new Error('The module declares encrypted saved objects but the process has no ESO');
        }
        encryption = deps.encryptedSavedObjects;
        module.encryptedSavedObjectTypes.forEach((registration) =>
          deps.encryptedSavedObjects!.registerType(registration)
        );
      }
      (module.uiSettings?.defaults ?? []).forEach((defaults) => core.uiSettings.register(defaults));
      (module.uiSettings?.globalDefaults ?? []).forEach((defaults) =>
        core.uiSettings.registerGlobal(defaults)
      );

      // The event types the runner reports; Core's analytics refuses an event it does not know.
      registerTaskAnalyticsEventTypes(module, core.analytics);

      // Where the feature usage of the cluster is kept; the licensing plugin registers it in Kibana.
      core.savedObjects.registerType(featureUsageSavedObjectType);

      if (module.usageCounters) {
        usageCounters = createStandaloneUsageCounters({
          logger: initializerContext.logger.get('usageCounters'),
          settings: reviveSettingsByPlugin(init.settings).usageCollection as never,
        });
        usageCounters.setup(core.savedObjects);
      }

      // The plugin that owns spaces is not running: the active space is the one the run's request names.
      core.savedObjects.setSpacesExtension(
        ({ request }) =>
          new StandaloneSpacesExtension((request as { spaceId?: string })?.spaceId ?? 'default')
      );

      // Before its first run the process proves it registered what Kibana did, or declines the run.
      const parityGuard = createParityGuard({
        hooks: module.parity,
        expected: init.parity,
        logger,
        taskType: module.type,
      });
      deps.taskManager.registerTaskDefinitions({
        [module.type]: toTaskDefinition(module, () => hostPromise, parityGuard),
      });
    },

    start(core: CoreStart, deps: StartDeps) {
      if (!fips) throw new Error('Core FIPS service has not initialized');
      const { env } = initializerContext;
      const host: TaskHost = {
        analytics: {
          // A report that cannot be made (an unregistered event type) never fails the run.
          reportEvent: (eventType: string, eventData: object) => {
            try {
              core.analytics.reportEvent(eventType, eventData);
            } catch (error) {
              logger.warn(`Could not report the event "${eventType}": ${(error as Error).message}`);
            }
          },
        },
        onRunEnd: (flusher) => {
          context.flushers.push(flusher);
        },
        logger,
        parity: init.parity,
        elasticsearch: core.elasticsearch.client,
        savedObjects: core.savedObjects,
        executionContext: core.executionContext,
        security: { ...core.security, fips },
        userProfile: core.userProfile,
        http: {
          selfClient: core.http.selfClient,
          basePath: core.http.basePath,
          getServerInfo: core.http.getServerInfo,
        },
        server: {
          uuid: init.server?.uuid ?? env.instanceUuid,
          version: env.packageInfo.version,
          buildNum: init.server?.buildNum ?? Number.MAX_SAFE_INTEGER,
          publicBaseUrl: init.server?.publicBaseUrl,
          isServerless: init.server?.isServerless ?? false,
        },
      };

      if (module.encryptedSavedObjectTypes?.length && deps.encryptedSavedObjects) {
        host.encryptedSavedObjects = {
          getClient: deps.encryptedSavedObjects.getClient,
          isEncryptionError: deps.encryptedSavedObjects.isEncryptionError,
          canEncrypt: encryption?.canEncrypt ?? false,
        };
      }
      if (module.eventLog) {
        const { eventLog, flush, stop } = module.eventLog.create({
          asInternalUser: core.elasticsearch.client.asInternalUser,
          logger: initializerContext.logger.get('eventLog'),
          kibanaUuid: init.server?.uuid,
          kibanaVersion: env.packageInfo.version,
          providers: module.eventLog.providers,
        });
        host.eventLog = eventLog;
        context.flushers.push(flush);
        // Flushes what the adapter still buffers before the process exits.
        stops.push(stop);
      }
      const taskManagerSettings = reviveSettingsByPlugin(init.settings).taskManager as
        | { api_key_type?: string; grant_uiam_api_keys?: boolean }
        | undefined;
      if (module.taskManager) {
        host.taskManager = createHostTaskScheduling({
          repository: core.savedObjects.createInternalRepository(['task']),
          esClient: core.elasticsearch.client.asInternalUser,
          logger: initializerContext.logger.get('taskManager'),
          // Tasks that carry the credentials of a request are written as Task Manager writes them.
          credentials: taskManagerSettings
            ? {
                savedObjects: core.savedObjects,
                security: core.security,
                apiKeyType: taskManagerSettings.api_key_type as never,
                grantUiamApiKeys: taskManagerSettings.grant_uiam_api_keys === true,
                canEncrypt: encryption?.canEncrypt ?? false,
                encryptedSavedObjects: deps.encryptedSavedObjects
                  ? { getClient: deps.encryptedSavedObjects.getClient }
                  : undefined,
              }
            : undefined,
          allowedTypes: new RegExp(
            (typeof module.taskManager === 'object' && module.taskManager.schedulableTypes
              ? module.taskManager.schedulableTypes
              : [/^actions:/]
            )
              .map(({ source }) => `(?:${source})`)
              .join('|')
          ),
        });
      }
      if (usageCounters) {
        host.usageCounters = usageCounters.start(core.savedObjects);
        // What the run counted is stored before the run answers, and once more on the way out.
        const counters = usageCounters;
        const flushUsageCounters = () => counters.flush();
        context.flushers.push(flushUsageCounters);
        stops.push(async () => {
          await usageCounters!.flush();
          usageCounters!.stop();
        });
      }
      if (module.uiSettings) host.uiSettings = core.uiSettings;
      if (module.dataStreams) host.dataStreams = core.dataStreams;
      if (module.featureFlags) host.featureFlags = createHostFeatureFlags();
      if (module.licensing) {
        const { featureUsage, flush } = createStandaloneFeatureUsage({
          repository: core.savedObjects.createInternalRepository([FEATURE_USAGE_SAVED_OBJECT_TYPE]),
          logger: initializerContext.logger.get('licensing'),
        });
        // What the run used is stored before it answers.
        const flushFeatureUsage = () => flush();
        context.flushers.push(flushFeatureUsage);
        host.licensing = {
          ...createStandaloneLicensing({
            asInternalUser: core.elasticsearch.client.asInternalUser,
            logger: initializerContext.logger.get('licensing'),
          }),
          featureUsage,
        };
      }
      if (module.settings?.length || init.settings) {
        // Everything Kibana sent, which also covers what contributions of other plugins read.
        const settings = reviveSettingsByPlugin(init.settings);
        const missing = (module.settings ?? []).filter((id) => !(id in settings));
        if (missing.length) {
          throw new Error(`The task process was not given the settings of: ${missing.join(', ')}`);
        }
        host.settings = settings;
      }
      if (module.contributions?.keys.length) host.contributions = context.contributions;
      if (module.taskPlugins?.length) {
        host.plugins = Object.fromEntries(
          module.taskPlugins.map(({ manifest }) => [manifest.id, deps[manifest.id]])
        );
      }
      resolveHost(host);
    },

    async stop() {
      await Promise.all(stops.map((stop) => stop()));
    },
  };
};

/** Where the module sits among the plugins of the process: after Task Manager and ESO. */
export const createModuleStaticPlugin = (
  kibanaVersion: string,
  taskPluginIds: string[] = []
): TaskStaticPlugin => ({
  manifest: {
    id: 'taskTypeModule',
    version: kibanaVersion,
    kibanaVersion,
    type: PluginType.standard,
    configPath: ['xpack', 'taskTypeModule'],
    requiredPlugins: ['taskManager'],
    optionalPlugins: ['encryptedSavedObjects', ...taskPluginIds],
    requiredBundles: [],
    runtimePluginDependencies: [],
    server: true,
    ui: false,
    owner: { name: 'Response Ops', githubTeam: 'response-ops' },
  },
  definition: { taskPlugin: plugin },
});
