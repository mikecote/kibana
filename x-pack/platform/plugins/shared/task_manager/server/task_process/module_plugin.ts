/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, PluginInitializer } from '@kbn/core/server';
import { PluginType } from '@kbn/core-base-common';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';
import type {
  EncryptedSavedObjectsPluginSetup,
  EncryptedSavedObjectsPluginStart,
} from '@kbn/encrypted-saved-objects-plugin/server';
import type { SavedObjectsType } from '@kbn/core-saved-objects-server';
import { setupSavedObjects as registerTaskManagerSavedObjects } from '../saved_objects';
import { toTaskDefinition } from '../task_type_module';
import type { TaskHost } from '../task_type_module';
import { createHostTaskScheduling } from './host_capabilities/task_scheduling';
import { createStandaloneLicensing } from './host_capabilities/licensing';
import { reviveSettingsByPlugin } from './settings';
import { StandaloneSpacesExtension } from './spaces_extension';
import { getTaskProcessContext } from './context';
import { createHostFeatureFlags, createHostTelemetry } from './telemetry';
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
const plugin: PluginInitializer<void, void, SetupDeps, StartDeps> = async (initializerContext) => {
  const context = getTaskProcessContext();
  const { module, init } = context;
  const logger = initializerContext.logger.get('task-process');
  const stops: Array<() => Promise<void>> = [];

  let resolveHost!: (host: TaskHost) => void;
  const hostPromise = new Promise<TaskHost>((resolve) => (resolveHost = resolve));
  context.host = hostPromise;
  let encryption: EncryptedSavedObjectsPluginSetup | undefined;

  return {
    setup(core: CoreSetup, deps: SetupDeps) {
      const types: SavedObjectsType[] = [];
      const seen = new Set<string>();
      for (const type of module.savedObjectTypes ?? []) {
        if (seen.has(type.name)) continue;
        seen.add(type.name);
        types.push(type);
      }
      types.forEach((type) => core.savedObjects.registerType(type));
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

      // The plugin that owns spaces is not running: the active space is the one the run's request names.
      core.savedObjects.setSpacesExtension(
        ({ request }) =>
          new StandaloneSpacesExtension((request as { spaceId?: string })?.spaceId ?? 'default')
      );

      deps.taskManager.registerTaskDefinitions({
        [module.type]: toTaskDefinition(module, () => hostPromise),
      });
    },

    start(core: CoreStart, deps: StartDeps) {
      const { env } = initializerContext;
      const { featureUsage, ...reporting } = createHostTelemetry();
      const host: TaskHost = {
        ...reporting,
        logger,
        elasticsearch: core.elasticsearch.client,
        savedObjects: core.savedObjects,
        executionContext: core.executionContext,
        security: core.security,
        userProfile: core.userProfile,
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
        const { eventLog, stop } = module.eventLog.create({
          asInternalUser: core.elasticsearch.client.asInternalUser,
          logger: initializerContext.logger.get('eventLog'),
          kibanaUuid: init.server?.uuid,
          kibanaVersion: env.packageInfo.version,
          providers: module.eventLog.providers,
        });
        host.eventLog = eventLog;
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
      if (module.uiSettings) host.uiSettings = core.uiSettings;
      if (module.featureFlags) host.featureFlags = createHostFeatureFlags();
      if (module.licensing) {
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
): StaticPlugin => ({
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
  definition: { plugin: plugin as never },
});
