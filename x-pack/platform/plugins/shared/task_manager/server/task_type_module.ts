/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable } from 'rxjs';
import type { Logger } from '@kbn/logging';
import type { IClusterClient } from '@kbn/core-elasticsearch-server';
import type { SavedObjectsServiceStart, SavedObjectsType } from '@kbn/core-saved-objects-server';
import type { ExecutionContextStart } from '@kbn/core-execution-context-server';
import type { SecurityServiceStart } from '@kbn/core-security-server';
import type { UiSettingsParams } from '@kbn/core-ui-settings-common';
import type { UiSettingsServiceStart } from '@kbn/core-ui-settings-server';
import type { ILicense } from '@kbn/licensing-types';
import type {
  EncryptedSavedObjectTypeRegistration,
  EncryptedSavedObjectsClient,
} from '@kbn/encrypted-saved-objects-plugin/server';
import type { CancellableTask, RunContext } from './task';
import type { TaskManagerStartContract } from './plugin';
import type { TaskRegisterDefinition } from './task_type_dictionary';

export interface TaskHostEventLog {
  // Method signatures, so the plugin's own `IEventLogService` is assignable.
  registerProviderActions(provider: string, actions: string[]): void;
  getLogger(initialProperties: unknown): unknown;
  getIndexPattern?(): string;
}

/**
 * The event log a module needs. Task Manager cannot import the event log plugin, so the module brings
 * the factory of its writer (the plugin exports `createStandaloneEventLog`), which a task process
 * calls and Kibana ignores, because Kibana hands over the plugin's own service.
 */
export interface TaskEventLogCapability {
  providers: Array<{ provider: string; actions: string[] }>;
  create: (deps: {
    asInternalUser: IClusterClient['asInternalUser'];
    logger: Logger;
    /** Kibana's, so events carry the same `kibana.server_uuid` as when Kibana writes them. */
    kibanaUuid?: string;
    kibanaVersion: string;
    providers: TaskEventLogCapability['providers'];
  }) => { eventLog: TaskHostEventLog; stop: () => Promise<void> };
}

/**
 * What a task type module may use. In Kibana this is Core and the plugins that registered the task
 * type; in a task process it is built from Core's building blocks. A module never knows which, so it
 * runs the same in both. The members after `server` are present only when the module declares them.
 */
export interface TaskHost {
  logger: Logger;
  elasticsearch: Pick<IClusterClient, 'asInternalUser' | 'asScoped'>;
  savedObjects: Pick<
    SavedObjectsServiceStart,
    'createInternalRepository' | 'getScopedClient' | 'getUnsafeInternalClient' | 'getTypeRegistry'
  >;
  /** A pass-through in a task process. */
  executionContext: Pick<ExecutionContextStart, 'withContext' | 'getAsLabels'>;
  /** Core's default implementation in a task process: no user, no audit, no UIAM. */
  security: Pick<SecurityServiceStart, 'authc' | 'audit'>;
  /** Kibana's identity and public address. */
  server: {
    uuid: string;
    version: string;
    buildNum: number;
    publicBaseUrl?: string;
    isServerless: boolean;
  };

  /** Declared with `encryptedSavedObjectTypes`. */
  encryptedSavedObjects?: {
    getClient: (options?: { includedHiddenTypes?: string[] }) => EncryptedSavedObjectsClient;
    isEncryptionError: (error: Error) => boolean;
    canEncrypt: boolean;
  };
  /**
   * Declared with `eventLog`. The shape of the event log plugin's `IEventLogService`, which Task
   * Manager cannot import without a project reference cycle; cast it where it is used.
   */
  eventLog?: TaskHostEventLog;
  /** Declared with `taskManager`. */
  taskManager?: Pick<TaskManagerStartContract, 'bulkSchedule' | 'aggregate'>;
  /** Declared with `uiSettings`. */
  uiSettings?: Pick<UiSettingsServiceStart, 'asScopedToClient'>;
  /** Declared with `licensing`. */
  licensing?: { license$: Observable<ILicense> };
  /** Validated plugin configs by plugin id, for the ids listed in `settings`. */
  settings?: Record<string, unknown>;
}

/**
 * A task type as one importable file: the definition Task Manager registers, minus the runner
 * factory, plus the factory that receives the host.
 */
export interface TaskTypeModule extends Omit<TaskRegisterDefinition, 'createTaskRunner'> {
  /** The Task Manager task type, such as `task_manager:delete_inactive_background_task_nodes`. */
  type: string;
  /**
   * Saved object types the runner reads or writes. A task process registers them; Kibana already
   * has them.
   */
  savedObjectTypes?: SavedObjectsType[];
  /** Encrypted saved object registrations the runner needs; a task process registers them. */
  encryptedSavedObjectTypes?: EncryptedSavedObjectTypeRegistration[];
  /** Gives the runner `host.eventLog`. */
  eventLog?: TaskEventLogCapability;
  /** Gives the runner `host.taskManager`, to schedule tasks and aggregate them. */
  taskManager?: true;
  /** Gives the runner `host.uiSettings`, with these defaults registered in a task process. */
  uiSettings?: { defaults?: Array<Record<string, UiSettingsParams>> };
  /** Gives the runner `host.licensing`. */
  licensing?: true;
  /** Ids of the plugins whose validated config the runner reads, as `host.settings[id]`. */
  settings?: string[];
  createTaskRunner: (context: RunContext, host: TaskHost) => CancellableTask;
}

/**
 * The real services for the capabilities a module declares, which the plugin that owns them hands
 * over when it registers the task type. Task Manager supplies the rest itself.
 */
export interface TaskTypeHostExtensions {
  encryptedSavedObjects?: () => Promise<NonNullable<TaskHost['encryptedSavedObjects']>>;
  /** The keys a task process needs to decrypt; sent to it over the fork channel. */
  getEncryptionKeys?: () => { encryptionKey?: string; decryptionOnlyKeys: string[] };
  eventLog?: TaskHost['eventLog'];
}

export interface TaskTypeRegistrationOptions {
  /** The logger the runner gets; defaults to Task Manager's. */
  logger?: Logger;
  hostExtensions?: TaskTypeHostExtensions;
  /** Validated plugin configs the module lists in `settings`, read when a run or a process starts. */
  settings?: Record<string, () => unknown>;
}

/** Throws when a declared capability has no real service to hand to the module in Kibana. */
export const assertHostExtensions = (
  module: TaskTypeModule,
  options: TaskTypeRegistrationOptions = {}
) => {
  const missing: string[] = [];
  const { hostExtensions: ext = {}, settings = {} } = options;
  if (module.encryptedSavedObjectTypes?.length) {
    if (!ext.encryptedSavedObjects) missing.push('hostExtensions.encryptedSavedObjects');
    if (!ext.getEncryptionKeys) missing.push('hostExtensions.getEncryptionKeys');
  }
  if (module.eventLog && !ext.eventLog) missing.push('hostExtensions.eventLog');
  for (const id of module.settings ?? []) {
    if (!settings[id]) missing.push(`settings.${id}`);
  }
  if (missing.length) {
    throw new Error(
      `Task type ${
        module.type
      } declares capabilities that registerTaskType was not given: ${missing.join(', ')}`
    );
  }
};

export const defineTaskType = (module: TaskTypeModule): TaskTypeModule => module;

/**
 * Adapts a module to what `registerTaskDefinitions` takes. The host is resolved when the first
 * run is created, which is after Core has started.
 */
export const toTaskDefinition = (
  module: TaskTypeModule,
  getHost: () => Promise<TaskHost>
): TaskRegisterDefinition => {
  const {
    type,
    savedObjectTypes,
    encryptedSavedObjectTypes,
    eventLog,
    taskManager,
    uiSettings,
    licensing,
    settings,
    createTaskRunner,
    ...definition
  } = module;
  return {
    ...definition,
    createTaskRunner: (context: RunContext): CancellableTask => {
      let created: CancellableTask | undefined;
      let cancelled = false;
      return {
        run: async () => {
          created = createTaskRunner(context, await getHost());
          // Cancelled while the host was resolving: the run never starts.
          if (cancelled) await created.cancel?.();
          return created.run();
        },
        cancel: async () => {
          cancelled = true;
          return created?.cancel?.();
        },
        cleanup: async () => created?.cleanup?.(),
      };
    },
  };
};
