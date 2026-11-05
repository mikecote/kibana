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
import type { AnalyticsServiceStart } from '@kbn/core-analytics-server';
import type { FeatureFlagsStart } from '@kbn/core-feature-flags-server';
import type { UserProfileServiceStart } from '@kbn/core-user-profile-server';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';
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

  /**
   * Core's analytics in Kibana. In a task process the events are returned with the run, and the
   * Kibana that dispatched it reports them.
   */
  analytics: Pick<AnalyticsServiceStart, 'reportEvent'>;
  /**
   * A channel of a plugin, such as security telemetry, that only Kibana can send on: a task process
   * returns the payloads with the run and Kibana hands them to the sink the plugin registered with
   * `registerTaskProcessTelemetrySink`; in Kibana the sink is called directly.
   */
  telemetry: { report: (kind: string, payload: unknown) => void };

  /** Core's user profile service; in a task process the security task plugin's delegate answers. */
  userProfile?: UserProfileServiceStart;
  /** Declared with `featureFlags`. */
  featureFlags?: Pick<
    FeatureFlagsStart,
    'getBooleanValue$' | 'getStringValue$' | 'getNumberValue$'
  >;

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
  taskManager?: Pick<TaskManagerStartContract, 'schedule' | 'bulkSchedule' | 'aggregate'>;
  /** Declared with `uiSettings`. */
  uiSettings?: Pick<UiSettingsServiceStart, 'asScopedToClient'>;
  /** Declared with `licensing`. */
  licensing?: {
    license$: Observable<ILicense>;
    /** Records that a licensed feature was used; reported by Kibana when a task process returns. */
    featureUsage?: { notifyUsage: (featureName: string, usedAt?: number | Date) => void };
  };
  /** Validated plugin configs by plugin id, for the ids listed in `settings`. */
  settings?: Record<string, unknown>;
  /** A task process only: what plugins contribute, by key, for the keys the module lists. */
  contributions?: Record<string, unknown[]>;
  /** A task process only: the `start` contracts of `taskPlugins`, by plugin id. */
  plugins?: Record<string, unknown>;
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
  /**
   * Gives the runner `host.taskManager`, to schedule tasks and aggregate them. A task process does
   * not know the task definitions, so it only schedules the task types that match `schedulableTypes`
   * (default: the `actions:` tasks that enqueue connectors).
   */
  taskManager?: true | { schedulableTypes?: RegExp[] };
  /** Gives the runner `host.uiSettings`, with these defaults registered in a task process. */
  uiSettings?: { defaults?: Array<Record<string, UiSettingsParams>> };
  /** Gives the runner `host.licensing`. */
  licensing?: true;
  /**
   * Set when this task type can never run in a task process yet, with the reason. Its bundle is tiny
   * and declines every run, and Kibana does not start it, because it knows the answer.
   */
  declinesAll?: string;
  /** Ids of the plugins whose validated config the runner reads, as `host.settings[id]`. */
  settings?: string[];
  /**
   * Plugins this task type's process runs besides Core, which Core composes like the plugins of
   * Kibana: their config, dependencies, `setup` and `start` run in dependency order, so a plugin
   * can register with Core what Kibana would have it register, such as the security delegate. Each
   * is the plugin's own slim implementation for a task process (`server/task_plugin.ts`), and the
   * runner reads what they return from `start` as `host.plugins[id]`. Kibana has the real plugins.
   */
  taskPlugins?: ReadonlyArray<StaticPlugin>;
  /**
   * Feature flags the runner reads, with their fallbacks, as `host.featureFlags`. Kibana evaluates
   * them with its feature flags service when it dispatches a run and sends the values, so a flag
   * flipped between runs reaches the next one. The type of the fallback is the type of the flag.
   */
  featureFlags?: Record<string, boolean | string | number>;
  /**
   * What other plugins contribute to this task type's process (`taskTypeContributions` in their
   * `kibana.jsonc`). The bundler gathers every plugin's files under each key, and a task process
   * hands the exports to `apply`, which returns the module with what they declare added, and to the
   * runner as `host.contributions[key]`. Kibana has the plugins themselves and ignores this.
   */
  contributions?: {
    keys: string[];
    apply?: (contributions: Record<string, unknown[]>) => TaskTypeModule;
  };
  createTaskRunner: (context: RunContext, host: TaskHost) => CancellableTask;
}

/**
 * The real services for the capabilities a module declares, which the plugin that owns them hands
 * over when it registers the task type. Task Manager supplies the rest itself.
 */
export interface TaskTypeHostExtensions {
  encryptedSavedObjects?: () => Promise<NonNullable<TaskHost['encryptedSavedObjects']>>;
  /**
   * The keys the task process of this task type may decrypt with; sent to it over the fork channel
   * whether or not the module registered here declares encrypted saved objects, because the module
   * a process runs is another instance of it.
   */
  getEncryptionKeys?: () => { encryptionKey?: string; decryptionOnlyKeys: string[] };
  eventLog?: TaskHost['eventLog'];
}

export interface TaskTypeRegistrationOptions {
  /** The logger the runner gets; defaults to Task Manager's. */
  logger?: Logger;
  hostExtensions?: TaskTypeHostExtensions;
  /**
   * Validated plugin configs by plugin id, read when a run or a process starts. Every one is sent to
   * the task process of this task type; the module it runs reads the ones it lists in `settings`.
   */
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
    // Task Manager sends its own settings to every task process.
    if (id !== 'taskManager' && !settings[id]) missing.push(`settings.${id}`);
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
    contributions,
    taskPlugins,
    featureFlags,
    declinesAll,
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
