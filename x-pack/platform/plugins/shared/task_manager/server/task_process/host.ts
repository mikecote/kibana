/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClientConfig } from '@kbn/core-elasticsearch-server';
import type { SavedObjectsType } from '@kbn/core-saved-objects-server';
import { LoggingSystem } from '@kbn/core-logging-server-internal';
import {
  AgentManager,
  ClusterClient,
  getRequestHandlerFactory,
} from '@kbn/core-elasticsearch-client-server-internal';
import { uiSettingsType } from '@kbn/core-ui-settings-server-internal';
import type { TaskHost, TaskTypeModule } from '../task_type_module';
import { setupSavedObjects as getTaskManagerSavedObjectTypes } from '../saved_objects';
import { reviveSettingsByPlugin } from './settings';
import type { TaskProcessInit } from './wire';
import { createStandaloneSavedObjects } from './host_capabilities/saved_objects';
import { createStandaloneEncryptedSavedObjects } from './host_capabilities/encrypted_saved_objects';
import { createHostTaskScheduling } from './host_capabilities/task_scheduling';
import { createStandaloneUiSettings } from './host_capabilities/ui_settings';
import { createStandaloneLicensing } from './host_capabilities/licensing';
import {
  createStandaloneSecurity,
  standaloneExecutionContext,
} from './host_capabilities/core_stubs';

export interface StandaloneHostOptions {
  elasticsearch: ElasticsearchClientConfig;
  kibanaVersion: string;
  /** What the process was sent besides the Elasticsearch connection. */
  init?: Pick<
    TaskProcessInit,
    'server' | 'encryptedSavedObjects' | 'uiSettingsOverrides' | 'settings'
  >;
  /** The capabilities the module declares; the host builds only those. */
  module?: Pick<
    TaskTypeModule,
    | 'savedObjectTypes'
    | 'encryptedSavedObjectTypes'
    | 'eventLog'
    | 'taskManager'
    | 'uiSettings'
    | 'licensing'
    | 'settings'
  >;
}

export interface StandaloneHost {
  host: TaskHost;
  stop(): Promise<void>;
}

/** The saved object types Task Manager itself registers, which `host.taskManager` writes. */
const getTaskManagerTypes = (): SavedObjectsType[] => {
  const types: SavedObjectsType[] = [];
  getTaskManagerSavedObjectTypes({
    registerType: (type: SavedObjectsType) => types.push(type),
  } as never);
  return types;
};

/**
 * What a task type module gets in a process of its own: Core's logging system, Core's own
 * Elasticsearch `ClusterClient`, and, for what the module declares, Core's saved objects repository
 * and client provider, the encrypted saved objects service, the event log writer, task scheduling,
 * ui settings and the license. No plugins, no HTTP server, no migrations.
 */
export const createStandaloneHost = async ({
  elasticsearch,
  kibanaVersion,
  init,
  module = {},
}: StandaloneHostOptions): Promise<StandaloneHost> => {
  const loggingSystem = new LoggingSystem();
  await loggingSystem.upgrade();
  const logger = loggingSystem.get('task-process');

  const esLogger = loggingSystem.get('elasticsearch');
  const agentManager = new AgentManager(esLogger.get('agent-manager'), {
    dnsCacheTtlInSeconds: elasticsearch.dnsCacheTtl?.asSeconds() ?? 0,
  });
  const client = new ClusterClient({
    config: elasticsearch,
    logger: esLogger,
    type: 'data',
    agentFactoryProvider: agentManager,
    kibanaVersion,
    onRequestHandlerFactory: getRequestHandlerFactory(false),
  });

  const server: TaskHost['server'] = {
    uuid: init?.server?.uuid ?? '',
    version: kibanaVersion,
    buildNum: init?.server?.buildNum ?? Number.MAX_SAFE_INTEGER,
    publicBaseUrl: init?.server?.publicBaseUrl,
    isServerless: init?.server?.isServerless ?? false,
  };

  const types: SavedObjectsType[] = [...(module.savedObjectTypes ?? [])];
  if (module.taskManager) types.push(...getTaskManagerTypes());
  if (module.uiSettings) types.push(uiSettingsType as SavedObjectsType);

  const standaloneSavedObjects = createStandaloneSavedObjects({
    types,
    client: client.asInternalUser,
    logger: loggingSystem.get('savedobjects-service'),
    kibanaVersion,
  });

  const host: TaskHost = {
    logger,
    elasticsearch: {
      asInternalUser: client.asInternalUser,
      asScoped: client.asScoped.bind(client),
    },
    savedObjects: standaloneSavedObjects.savedObjects,
    executionContext: standaloneExecutionContext,
    security: createStandaloneSecurity(),
    server,
  };

  const stops: Array<() => Promise<void>> = [];

  if (module.encryptedSavedObjectTypes?.length) {
    host.encryptedSavedObjects = createStandaloneEncryptedSavedObjects({
      keys: init?.encryptedSavedObjects,
      registrations: module.encryptedSavedObjectTypes,
      standalone: standaloneSavedObjects,
      logger: loggingSystem.get('encryptedSavedObjects'),
    });
  }
  if (module.eventLog) {
    const { eventLog, stop } = module.eventLog.create({
      asInternalUser: client.asInternalUser,
      logger: loggingSystem.get('eventLog'),
      kibanaUuid: init?.server?.uuid,
      kibanaVersion,
      providers: module.eventLog.providers,
    });
    host.eventLog = eventLog;
    // Flushes what the adapter still buffers before the process exits.
    stops.push(stop);
  }
  if (module.taskManager) {
    host.taskManager = createHostTaskScheduling({
      repository: standaloneSavedObjects.savedObjects.createInternalRepository(['task']),
      esClient: client.asInternalUser,
      logger: loggingSystem.get('plugins', 'taskManager'),
      allowedTypes: /^actions:/,
    });
  }
  if (module.uiSettings) {
    host.uiSettings = createStandaloneUiSettings({
      kibanaVersion,
      buildNum: server.buildNum,
      overrides: init?.uiSettingsOverrides,
      logger: loggingSystem.get('ui-settings'),
      module,
    });
  }
  if (module.licensing) {
    host.licensing = createStandaloneLicensing({
      asInternalUser: client.asInternalUser,
      logger: loggingSystem.get('licensing'),
    });
  }
  if (module.settings?.length) {
    const settings = reviveSettingsByPlugin(init?.settings);
    const missing = module.settings.filter((id) => !(id in settings));
    if (missing.length) {
      throw new Error(`The task process was not given the settings of: ${missing.join(', ')}`);
    }
    host.settings = settings;
  }

  return {
    host,
    stop: async () => {
      await Promise.all(stops.map((stop) => stop()));
      await client.close();
      await loggingSystem.stop();
    },
  };
};
