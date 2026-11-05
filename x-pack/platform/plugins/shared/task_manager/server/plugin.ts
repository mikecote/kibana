/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable } from 'rxjs';
import { combineLatest, firstValueFrom, Subject, BehaviorSubject } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs';
import type { estypes } from '@elastic/elasticsearch';
import type {
  UsageCollectionSetup,
  UsageCollectionStart,
  UsageCounter,
} from '@kbn/usage-collection-plugin/server';
import type {
  PluginInitializerContext,
  Plugin,
  CoreSetup,
  Logger,
  CoreStart,
} from '@kbn/core/server';
import type { AnalyticsServiceStart } from '@kbn/core-analytics-server';
import type { FakeRequestEnricher } from '@kbn/core-security-server';
import type { CloudSetup, CloudStart } from '@kbn/cloud-plugin/server';
import type { EncryptedSavedObjectsClient } from '@kbn/encrypted-saved-objects-shared';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { PublicMethodsOf } from '@kbn/utility-types';
import type { InvalidateAPIKeysParams } from '@kbn/security-plugin-types-server';
import { join } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import type { IElasticsearchConfig } from '@kbn/core-elasticsearch-server';
import type { TaskProcessDispatch } from './task_process/remote_task_runner';
import { serializeElasticsearchConfig } from './task_process/es_config';
import { TaskProcessSupervisor } from './task_process/supervisor';
import type { TaskHost, TaskTypeModule, TaskTypeRegistrationOptions } from './task_type_module';
import { assertHostExtensions, toTaskDefinition } from './task_type_module';
import { serializeSettings } from './task_process/settings';
import type { TaskProcessInit } from './task_process/wire';
import { taskType as deleteInactiveNodesTaskType } from './task_types/delete_inactive_nodes.task';
import { taskType as markRemovedTasksTaskType } from './task_types/mark_removed_tasks_as_unrecognized.task';
import { scheduleDeleteInactiveNodesTaskDefinition } from './kibana_discovery_service/delete_inactive_nodes_task';
import { KibanaDiscoveryService } from './kibana_discovery_service';
import { TaskExecutionControlService } from './execution_control';
import { TaskPollingLifecycle } from './polling_lifecycle';
import type { TaskManagerConfig } from './config';
import type { Middleware } from './lib/middleware';
import { createInitialMiddleware, addMiddlewareToChain } from './lib/middleware';
import { removeIfExists } from './lib/remove_if_exists';
import {
  setupSavedObjects,
  BACKGROUND_TASK_NODE_SO_NAME,
  TASK_SO_NAME,
  INVALIDATE_API_KEY_SO_NAME,
  TASK_EXECUTION_CONTROL_SO_NAME,
} from './saved_objects';
import type { TaskDefinitionRegistry } from './task_type_dictionary';
import { TaskTypeDictionary } from './task_type_dictionary';
import type { AggregationOpts, FetchResult, SearchOpts } from './task_store';
import { TaskStore } from './task_store';
import { TaskScheduling } from './task_scheduling';
import {
  backgroundTaskUtilizationRoute,
  healthRoute,
  metricsRoute,
  executionControlRoutes,
} from './routes';
import type { MonitoringStats } from './monitoring';
import { createMonitoringStats } from './monitoring';
import type { ConcreteTaskInstance, TaskEventLogger } from './task';
import {
  registerEventLogTelemetryTask,
  registerTaskManagerUsageCollector,
  scheduleEventLogTelemetryTask,
} from './usage';
import { TASK_MANAGER_CLAIM_NUDGE_INDEX, TASK_MANAGER_INDEX } from './constants';
import { TaskManagerClaimNudgeService } from './claim_nudge/claim_nudge_service';
import { AdHocTaskCounter } from './lib/adhoc_task_counter';
import { setupIntervalLogging } from './lib/log_health_metrics';
import type { Metrics } from './metrics';
import { metricsStream } from './metrics';
import { TaskManagerMetricsCollector } from './metrics/task_metrics_collector';
import { TaskPartitioner } from './lib/task_partitioner';
import { getDefaultCapacity } from './lib/get_default_capacity';
import { calculateStartingCapacity } from './lib/create_managed_configuration';
import { scheduleMarkRemovedTasksAsUnrecognizedDefinition } from './removed_tasks/mark_removed_tasks_as_unrecognized';
import { getElasticsearchAndSOAvailability } from './lib/get_es_and_so_availability';
import { LicenseSubscriber } from './license_subscriber';
import type {
  ApiKeyInvalidationFn,
  UiamApiKeyInvalidationFn,
} from './invalidate_api_keys/invalidate_api_keys_task';
import {
  registerInvalidateApiKeyTask,
  scheduleInvalidateApiKeyTask,
} from './invalidate_api_keys/invalidate_api_keys_task';
import { createApiKeyStrategy } from './api_key_strategy';

export interface TaskManagerSetupContract {
  /**
   * @deprecated
   */
  index: string;
  addMiddleware: (middleware: Middleware) => void;
  /**
   * Method for allowing consumers to register task definitions into the system.
   * @param taskDefinitions - The Kibana task definitions dictionary
   */
  registerTaskDefinitions: (taskDefinitions: TaskDefinitionRegistry) => void;
  /**
   * Registers a task type module: one file that holds the definition and the runner, and that can
   * also be bundled to run in a process of its own. The runner gets the host, which is Core here.
   * @param module - What `defineTaskType` returned
   * @param options.logger - The logger the runner gets; defaults to Task Manager's
   * @param options.hostExtensions - The real services for the capabilities the module declares
   * @param options.settings - Getters of the plugin configs the module lists in `settings`
   */
  registerTaskType: (module: TaskTypeModule, options?: TaskTypeRegistrationOptions) => void;
  registerCanEncryptedSavedObjects: (canEncrypt: boolean) => void;
  registerTaskEventLogger: (logger: TaskEventLogger) => void;
  /**
   * Registers where what a task process reported on a channel of a plugin goes. A process cannot
   * send it, so it returns the payloads with the run and Kibana hands them to the sink of the same
   * kind; a task type that runs in Kibana calls the sink directly through `host.telemetry`.
   */
  registerTaskProcessTelemetrySink: (kind: string, sink: (payload: unknown) => void) => void;
}

export type TaskManagerStartContract = Pick<
  TaskScheduling,
  | 'schedule'
  | 'runSoon'
  | 'ensureScheduled'
  | 'bulkUpdateSchedules'
  | 'bulkEnable'
  | 'bulkDisable'
  | 'bulkSchedule'
  | 'bulkUpdateState'
> &
  Pick<TaskStore, 'fetch' | 'aggregate' | 'get' | 'bulkGet' | 'remove' | 'bulkRemove'> & {
    removeIfExists: TaskStore['remove'];
  } & {
    getRegisteredTypes: () => string[];
    registerEncryptedSavedObjectsClient: (
      client: EncryptedSavedObjectsClient,
      isEncryptionError?: (error: Error) => boolean
    ) => void;
    registerApiKeyInvalidateFn: (fn?: ApiKeyInvalidationFn) => void;
    registerUiamApiKeyInvalidateFn: (fn?: UiamApiKeyInvalidationFn) => void;
  };

export interface TaskManagerPluginsStart {
  licensing: LicensingPluginStart;
  cloud?: CloudStart;
  usageCollection?: UsageCollectionStart;
}

export interface TaskManagerPluginsSetup {
  cloud?: CloudSetup;
  usageCollection?: UsageCollectionSetup;
}

const LogHealthForBackgroundTasksOnlyMinutes = 60;

export class TaskManagerPlugin
  implements
    Plugin<
      TaskManagerSetupContract,
      TaskManagerStartContract,
      TaskManagerPluginsSetup,
      TaskManagerPluginsStart
    >
{
  private taskPollingLifecycle?: TaskPollingLifecycle;
  private taskManagerId?: string;
  private usageCounter?: UsageCounter;
  private config: TaskManagerConfig;
  private logger: Logger;
  private definitions: TaskTypeDictionary;
  private middleware: Middleware = createInitialMiddleware();
  private elasticsearchAndSOAvailability$?: Observable<boolean>;
  private monitoringStats$ = new Subject<MonitoringStats>();
  private metrics$ = new Subject<Metrics>();
  private resetMetrics$ = new Subject<boolean>();
  private shouldRunBackgroundTasks: boolean;
  private readonly kibanaVersion: PluginInitializerContext['env']['packageInfo']['version'];
  private adHocTaskCounter: AdHocTaskCounter;
  private taskManagerMetricsCollector?: TaskManagerMetricsCollector;
  private nodeRoles: PluginInitializerContext['node']['roles'];
  private kibanaDiscoveryService?: KibanaDiscoveryService;
  private executionControlService?: TaskExecutionControlService;
  private heapSizeLimit: number = 0;
  private taskProcessDispatch?: TaskProcessDispatch;
  private readonly telemetrySinks = new Map<string, (payload: unknown) => void>();
  private analytics?: AnalyticsServiceStart;
  private featureFlagsService?: CoreStart['featureFlags'];
  private featureUsage?: LicensingPluginStart['featureUsage'];
  private taskProcessSupervisor?: TaskProcessSupervisor;
  /** The task types registered as modules: the ones that can run outside this process. */
  private readonly moduleTaskTypes = new Set<string>();
  private readonly moduleRegistrations = new Map<
    string,
    { module: TaskTypeModule; options?: TaskTypeRegistrationOptions }
  >();
  private getTaskProcessInit?: (
    taskType: string
  ) => Omit<TaskProcessInit, 'kind' | 'authToken' | 'elasticsearch' | 'kibanaVersion'> | undefined;
  private publicBaseUrl?: string;
  private getKibanaAddress?: () => string | undefined;
  private serverBasePath?: string;
  private elasticsearchConfig?: IElasticsearchConfig;
  private numOfKibanaInstances$: Subject<number> = new BehaviorSubject(1);
  private canEncryptSavedObjects: boolean;
  private licenseSubscriber?: PublicMethodsOf<LicenseSubscriber>;
  private invalidateApiKeyFn?: ApiKeyInvalidationFn;
  private taskEventLogger?: TaskEventLogger;
  private invalidateUiamApiKeyFn?: UiamApiKeyInvalidationFn;
  private taskStore?: TaskStore;
  private startContract?: TaskManagerStartContract;
  private enrichFakeRequest?: FakeRequestEnricher;
  private claimNudgeService?: TaskManagerClaimNudgeService;

  constructor(private readonly initContext: PluginInitializerContext) {
    this.initContext = initContext;
    this.logger = initContext.logger.get();
    this.config = initContext.config.get<TaskManagerConfig>();
    this.definitions = new TaskTypeDictionary(this.logger);
    this.kibanaVersion = initContext.env.packageInfo.version;
    this.nodeRoles = initContext.node.roles;
    this.shouldRunBackgroundTasks = this.nodeRoles.backgroundTasks;
    this.adHocTaskCounter = new AdHocTaskCounter();
    this.canEncryptSavedObjects = false;
  }

  isNodeBackgroundTasksOnly() {
    const { backgroundTasks, migrator, ui } = this.nodeRoles;
    return backgroundTasks && !migrator && !ui;
  }

  private invalidateApiKey(params: InvalidateAPIKeysParams) {
    if (this.invalidateApiKeyFn) {
      return this.invalidateApiKeyFn(params);
    }
  }

  private get invalidateUiamApiKey(): UiamApiKeyInvalidationFn | undefined {
    return this.invalidateUiamApiKeyFn;
  }

  public setup(
    core: CoreSetup<TaskManagerPluginsStart, TaskManagerStartContract>,
    plugins: TaskManagerPluginsSetup
  ): TaskManagerSetupContract {
    const isServerless = this.initContext.env.packageInfo.buildFlavor === 'serverless';
    const clusterClientPromise = core
      .getStartServices()
      .then(([coreServices]) => coreServices.elasticsearch.client);
    this.elasticsearchAndSOAvailability$ = getElasticsearchAndSOAvailability({
      core$: core.status.core$,
      isServerless,
      logger: this.logger,
      getClusterClient: () => clusterClientPromise,
    });

    core.metrics
      .getOpsMetrics$()
      .pipe(distinctUntilChanged())
      .subscribe((metrics) => {
        this.heapSizeLimit = metrics.process.memory.heap.size_limit;
      });

    setupSavedObjects(core.savedObjects);

    // Child processes connect to Elasticsearch the way Kibana does.
    core.elasticsearch.legacy.config$.subscribe((config) => {
      this.elasticsearchConfig = config;
    });
    this.publicBaseUrl = core.http.basePath.publicBaseUrl;
    // How a process reaches this Kibana: the public URL, or the address it listens on.
    this.getKibanaAddress = () => {
      if (this.publicBaseUrl) return this.publicBaseUrl;
      const { protocol, hostname, port } = core.http.getServerInfo();
      if (protocol === 'socket') return undefined;
      const host = hostname === '0.0.0.0' || hostname === '::' ? 'localhost' : hostname;
      return `${protocol}://${host.includes(':') ? `[${host}]` : host}:${port}${
        core.http.basePath.serverBasePath
      }`;
    };
    this.serverBasePath = core.http.basePath.serverBasePath;
    const getServerInfo = (publicBaseUrl?: string): TaskHost['server'] => ({
      uuid: this.initContext.env.instanceUuid,
      version: this.kibanaVersion,
      buildNum: this.initContext.env.packageInfo.buildNum,
      publicBaseUrl,
      isServerless,
    });
    const registerTaskType: TaskManagerSetupContract['registerTaskType'] = (module, options) => {
      assertHostExtensions(module, options);
      this.moduleTaskTypes.add(module.type);
      this.moduleRegistrations.set(module.type, { module, options });
      this.definitions.registerTaskDefinitions({
        [module.type]: toTaskDefinition(module, async () => {
          const [coreStart, pluginsStart] = await core.getStartServices();
          const extensions = options?.hostExtensions;
          const host: TaskHost = {
            analytics: coreStart.analytics,
            http: coreStart.http,
            ...(module.featureFlags ? { featureFlags: coreStart.featureFlags } : {}),
            telemetry: { report: (kind, payload) => this.telemetrySinks.get(kind)?.(payload) },
            logger: options?.logger ?? this.logger,
            elasticsearch: coreStart.elasticsearch.client,
            savedObjects: coreStart.savedObjects,
            executionContext: coreStart.executionContext,
            security: coreStart.security,
            server: getServerInfo(coreStart.http.basePath.publicBaseUrl),
          };
          if (module.encryptedSavedObjectTypes?.length) {
            host.encryptedSavedObjects = await extensions!.encryptedSavedObjects!();
          }
          if (module.eventLog) host.eventLog = extensions!.eventLog;
          if (extensions?.plugins) host.plugins = await extensions.plugins();
          if (module.taskManager) host.taskManager = this.startContract;
          if (module.uiSettings) host.uiSettings = coreStart.uiSettings;
          if (module.licensing) {
            host.licensing = {
              license$: pluginsStart.licensing.license$,
              featureUsage: pluginsStart.licensing.featureUsage,
            };
          }
          if (module.settings?.length) {
            host.settings = Object.fromEntries(
              module.settings.map((id) => [id, options!.settings![id]()])
            );
          }
          return host;
        }),
      });
    };
    // What a task type's process may be told is up to the plugin that registered the task type: the
    // module a process runs is a separate instance, which uses what it declared of it.
    this.getTaskProcessInit = (taskType) => {
      const registration = this.moduleRegistrations.get(taskType);
      if (!registration) return undefined;
      const { options } = registration;
      const init: Pick<TaskProcessInit, 'server' | 'encryptedSavedObjects' | 'settings'> = {
        server: {
          ...getServerInfo(this.getKibanaAddress?.() ?? this.publicBaseUrl),
          ...(this.serverBasePath ? { basePath: this.serverBasePath } : {}),
          isDev: this.initContext.env.mode.dev,
        } as TaskProcessInit['server'],
      };
      if (options?.hostExtensions?.getEncryptionKeys) {
        init.encryptedSavedObjects = options.hostExtensions.getEncryptionKeys();
      }
      init.settings = {
        ...(options?.settings
          ? Object.fromEntries(
              Object.entries(options.settings).map(([id, getSettings]) => [
                id,
                serializeSettings(getSettings()),
              ])
            )
          : {}),
        // What a process needs to schedule tasks with credentials as this Kibana does.
        taskManager: serializeSettings({
          api_key_type: this.config.api_key_type,
          grant_uiam_api_keys: this.config.grant_uiam_api_keys,
        }),
      } as TaskProcessInit['settings'];
      return init;
    };

    const { mode = 'in_process', remote } = this.config.task_execution ?? {};
    if (mode !== 'in_process') {
      this.taskProcessDispatch = {
        kibanaVersion: this.kibanaVersion,
        // The feature flags a task type declares, as Kibana's flag service answers them now.
        getFeatureFlags: async (taskType) => {
          const flags = this.moduleRegistrations.get(taskType)?.module.featureFlags;
          if (!flags || !this.featureFlagsService) return undefined;
          const service = this.featureFlagsService;
          const values = await Promise.all(
            Object.entries(flags).map(async ([name, fallback]) => {
              const value$ =
                typeof fallback === 'boolean'
                  ? service.getBooleanValue$(name, fallback)
                  : typeof fallback === 'number'
                  ? service.getNumberValue$(name, fallback)
                  : service.getStringValue$(name, fallback);
              // oxlint-disable-next-line @kbn/eslint/no_feature_flag_snapshot -- evaluated for every run that is dispatched, so each run reads the current flag value
              return [name, await firstValueFrom(value$ as Observable<boolean | string | number>)];
            })
          );
          return Object.fromEntries(values);
        },
        // What a process reports is sent here, by the services only Kibana has.
        reportTelemetry: (telemetry) => {
          for (const { eventType, data } of telemetry.events) {
            this.analytics?.reportEvent(eventType, data as object);
          }
          for (const { featureName, lastUsed } of telemetry.featureUsages) {
            this.featureUsage?.notifyUsage(featureName, lastUsed ? new Date(lastUsed) : undefined);
          }
          for (const { kind, payload } of telemetry.custom) {
            this.telemetrySinks.get(kind)?.(payload);
          }
        },
        getRoute: (taskType) => {
          if (!this.moduleTaskTypes.has(taskType)) return undefined;
          return mode === 'remote'
            ? { url: remote!.url.replace(/\/$/, ''), token: remote!.token }
            : this.taskProcessSupervisor?.getRoute(taskType);
        },
      };
    }

    this.taskManagerId = this.initContext.env.instanceUuid;

    if (!this.taskManagerId) {
      this.logger.error(
        `TaskManager is unable to start as there the Kibana UUID is invalid (value of the "server.uuid" configuration is ${this.taskManagerId})`
      );
      throw new Error(`TaskManager is unable to start as Kibana has no valid UUID assigned to it.`);
    } else {
      this.logger.info(`TaskManager is identified by the Kibana UUID: ${this.taskManagerId}`);
    }

    this.usageCounter = plugins.usageCollection?.createUsageCounter(`taskManager`);

    // Routes
    const router = core.http.createRouter();
    const { serviceStatus$, monitoredHealth$ } = healthRoute({
      router,
      monitoringStats$: this.monitoringStats$,
      logger: this.logger,
      taskManagerId: this.taskManagerId,
      config: this.config!,
      usageCounter: this.usageCounter!,
      kibanaVersion: this.kibanaVersion,
      kibanaIndexName: core.savedObjects.getDefaultIndex(),
      getClusterClient: () => clusterClientPromise,
      shouldRunTasks: this.shouldRunBackgroundTasks,
      docLinks: core.docLinks,
      numOfKibanaInstances$: this.numOfKibanaInstances$,
    });
    const monitoredUtilization$ = backgroundTaskUtilizationRoute({
      router,
      monitoringStats$: this.monitoringStats$,
      logger: this.logger,
      taskManagerId: this.taskManagerId,
      config: this.config!,
      usageCounter: this.usageCounter!,
      kibanaVersion: this.kibanaVersion,
      kibanaIndexName: core.savedObjects.getDefaultIndex(),
      getClusterClient: () => clusterClientPromise,
    });
    metricsRoute({
      router,
      logger: this.logger,
      metrics$: this.metrics$,
      resetMetrics$: this.resetMetrics$,
      taskManagerId: this.taskManagerId,
    });
    executionControlRoutes({
      router,
      logger: this.logger,
      // getStartServices resolves after start(), by which point the service and
      // the full task-type dictionary are available on every node.
      getSecurity: () => core.getStartServices().then(([coreStart]) => coreStart.security),
      getExecutionControlService: () =>
        core.getStartServices().then(() => this.executionControlService!),
      getDefinitions: () => this.definitions,
    });

    core.status.derivedStatus$.subscribe((status) =>
      this.logger.debug(`status core.status.derivedStatus now set to ${status.level}`)
    );
    serviceStatus$.subscribe((status) =>
      this.logger.debug(`status serviceStatus now set to ${status.level}`)
    );

    // here is where the system status is updated
    core.status.set(
      combineLatest([core.status.derivedStatus$, serviceStatus$]).pipe(
        map(([derivedStatus, serviceStatus]) =>
          serviceStatus.level >= derivedStatus.level ? serviceStatus : derivedStatus
        )
      )
    );

    const usageCollection = plugins.usageCollection;
    if (usageCollection) {
      registerTaskManagerUsageCollector(
        usageCollection,
        monitoredHealth$,
        monitoredUtilization$,
        this.config.unsafe.exclude_task_types,
        () => core.getStartServices().then(([, , startContract]) => startContract),
        this.logger
      );
    }

    registerEventLogTelemetryTask(this.logger, core.getStartServices, this.definitions);
    registerTaskType(deleteInactiveNodesTaskType);
    registerInvalidateApiKeyTask({
      configInterval: this.config.invalidate_api_key_task.interval,
      coreStartServices: core.getStartServices,
      getEncryptedSavedObjectsClient: () => this.taskStore?.getEncryptedSavedObjectsClient(),
      invalidateApiKeyFn: this.invalidateApiKey.bind(this),
      invalidateUiamApiKeyFn: () => this.invalidateUiamApiKey,
      logger: this.logger,
      removalDelay: this.config.invalidate_api_key_task.removalDelay,
      taskTypeDictionary: this.definitions,
    });
    registerTaskType(markRemovedTasksTaskType);

    if (this.config.unsafe.exclude_task_types.length) {
      this.logger.warn(
        `Excluding task types from execution: ${this.config.unsafe.exclude_task_types.join(', ')}`
      );
    }

    if (this.config.unsafe.authenticate_background_task_utilization === false) {
      this.logger.warn(`Disabling authentication for background task utilization API`);
    }

    // for nodes with background_tasks mode only, log health metrics every hour
    if (this.isNodeBackgroundTasksOnly()) {
      setupIntervalLogging(monitoredHealth$, this.logger, LogHealthForBackgroundTasksOnlyMinutes);
    }

    this.enrichFakeRequest = core.security.acquireFakeRequestEnricher();

    return {
      index: TASK_MANAGER_INDEX,
      addMiddleware: (middleware: Middleware) => {
        this.middleware = addMiddlewareToChain(this.middleware, middleware);
      },
      registerTaskDefinitions: (taskDefinition: TaskDefinitionRegistry) => {
        this.definitions.registerTaskDefinitions(taskDefinition);
      },
      registerTaskType,
      registerCanEncryptedSavedObjects: (canEncrypt: boolean) => {
        this.canEncryptSavedObjects = canEncrypt;
      },
      registerTaskEventLogger: (logger: TaskEventLogger) => {
        this.taskEventLogger = logger;
      },
      registerTaskProcessTelemetrySink: (kind, sink) => {
        this.telemetrySinks.set(kind, sink);
      },
    };
  }

  public start(
    core: CoreStart,
    { cloud, licensing }: TaskManagerPluginsStart
  ): TaskManagerStartContract {
    const { savedObjects, elasticsearch, executionContext, security } = core;
    this.analytics = core.analytics;
    this.featureFlagsService = core.featureFlags;
    this.featureUsage = licensing.featureUsage;
    const enrichFakeRequest = this.enrichFakeRequest;
    this.licenseSubscriber = new LicenseSubscriber(licensing.license$);
    const isServerless = this.initContext.env.packageInfo.buildFlavor === 'serverless';

    const savedObjectsRepository = savedObjects.createInternalRepository([
      TASK_SO_NAME,
      BACKGROUND_TASK_NODE_SO_NAME,
      INVALIDATE_API_KEY_SO_NAME,
      TASK_EXECUTION_CONTROL_SO_NAME,
    ]);

    if (this.config.claim_nudge.enabled) {
      this.claimNudgeService = new TaskManagerClaimNudgeService({
        logger: this.logger,
        esClient: elasticsearch.client.asInternalUser,
        index: TASK_MANAGER_CLAIM_NUDGE_INDEX,
        isServerless,
      });
    }

    this.kibanaDiscoveryService = new KibanaDiscoveryService({
      savedObjectsRepository,
      logger: this.logger,
      currentNode: this.taskManagerId!,
      config: this.config.discovery,
      onNodesCounted: (numOfNodes: number) => this.numOfKibanaInstances$.next(numOfNodes),
    });

    if (this.shouldRunBackgroundTasks) {
      this.kibanaDiscoveryService.start().catch(() => {});
    }

    // Runs on every node (including UI-only nodes) so the pause/resume API and
    // health output are consistent everywhere; enforcement only happens where a
    // TaskPollingLifecycle exists (background-task nodes).
    this.executionControlService = new TaskExecutionControlService({
      savedObjectsRepository,
      logger: this.logger,
      config: this.config.execution_control,
    });
    this.executionControlService.start().catch(() => {});

    const serializer = savedObjects.createSerializer();
    const apiKeyStrategy = createApiKeyStrategy(
      this.config.api_key_type,
      this.config.grant_uiam_api_keys,
      security,
      this.logger
    );
    const taskStore = new TaskStore({
      serializer,
      savedObjectsRepository,
      savedObjectsService: savedObjects,
      esClient: elasticsearch.client.asInternalUser,
      index: TASK_MANAGER_INDEX,
      definitions: this.definitions,
      taskManagerId: `kibana:${this.taskManagerId!}`,
      adHocTaskCounter: this.adHocTaskCounter,
      allowReadingInvalidState: this.config.allow_reading_invalid_state,
      logger: this.logger,
      security,
      canEncryptSavedObjects: this.canEncryptSavedObjects,
      getIsSecurityEnabled: this.licenseSubscriber?.getIsSecurityEnabled,
      executionContext,
      apiKeyStrategy,
    });
    this.taskStore = taskStore;

    const defaultCapacity = getDefaultCapacity({
      autoCalculateDefaultEchCapacity: this.config.auto_calculate_default_ech_capacity,
      claimStrategy: this.config?.claim_strategy,
      heapSizeLimit: this.heapSizeLimit,
      isCloud: cloud?.isCloudEnabled ?? false,
      isServerless,
      isBackgroundTaskNodeOnly: this.isNodeBackgroundTasksOnly(),
    });

    this.logger.info(
      `Task manager isCloud=${
        cloud?.isCloudEnabled ?? false
      } isServerless=${isServerless} claimStrategy=${
        this.config!.claim_strategy
      } isBackgroundTaskNodeOnly=${this.isNodeBackgroundTasksOnly()} heapSizeLimit=${
        this.heapSizeLimit
      } defaultCapacity=${defaultCapacity} autoCalculateDefaultEchCapacity=${
        this.config.auto_calculate_default_ech_capacity
      }`
    );

    const startingCapacity = calculateStartingCapacity(this.config!, this.logger, defaultCapacity);

    // Only poll for tasks if configured to run tasks
    if (this.shouldRunBackgroundTasks) {
      this.claimNudgeService?.start();

      this.taskManagerMetricsCollector = new TaskManagerMetricsCollector({
        logger: this.logger,
        store: taskStore,
        taskTypes: new Set(this.definitions.getAllTypes()),
        excludedTypes: new Set(this.config.unsafe.exclude_task_types),
      });

      const taskPartitioner = new TaskPartitioner({
        logger: this.logger,
        podName: this.taskManagerId!,
        kibanaDiscoveryService: this.kibanaDiscoveryService,
        kibanasPerPartition: this.config.kibanas_per_partition,
      });

      this.startTaskProcessSupervisor();
      this.taskPollingLifecycle = new TaskPollingLifecycle({
        config: this.config!,
        definitions: this.definitions,
        logger: this.logger,
        executionContext,
        taskStore,
        usageCounter: this.usageCounter,
        middleware: this.middleware,
        elasticsearchAndSOAvailability$: this.elasticsearchAndSOAvailability$!,
        executionControlService: this.executionControlService,
        taskPartitioner,
        startingCapacity,
        apiKeyStrategy,
        eventLogger: this.taskEventLogger!,
        enrichFakeRequest,
        taskProcessDispatch: this.taskProcessDispatch,
        claimNudgeService: this.claimNudgeService,
      });
    }

    createMonitoringStats({
      taskStore,
      elasticsearchAndSOAvailability$: this.elasticsearchAndSOAvailability$!,
      config: this.config!,
      logger: this.logger,
      adHocTaskCounter: this.adHocTaskCounter,
      taskDefinitions: this.definitions,
      taskPollingLifecycle: this.taskPollingLifecycle,
      executionControlService: this.executionControlService,
      startingCapacity,
    }).subscribe((stat) => this.monitoringStats$.next(stat));

    metricsStream({
      config: this.config!,
      logger: this.logger,
      reset$: this.resetMetrics$,
      taskPollingLifecycle: this.taskPollingLifecycle,
      taskManagerMetricsCollector: this.taskManagerMetricsCollector,
      definitions: this.definitions,
    }).subscribe((metric) => this.metrics$.next(metric));

    const taskScheduling = new TaskScheduling({
      logger: this.logger,
      taskStore,
      middleware: this.middleware,
      taskManagerId: taskStore.taskManagerId,
      definitions: this.definitions,
      taskPollingLifecycle: this.taskPollingLifecycle,
      claimNudgeService: this.claimNudgeService,
    });

    scheduleEventLogTelemetryTask(this.logger, taskScheduling).catch(() => {});
    scheduleDeleteInactiveNodesTaskDefinition(this.logger, taskScheduling).catch(() => {});
    scheduleInvalidateApiKeyTask(
      this.logger,
      taskScheduling,
      this.config.invalidate_api_key_task.interval
    ).catch(() => {});
    scheduleMarkRemovedTasksAsUnrecognizedDefinition(this.logger, taskScheduling).catch(() => {});

    this.startContract = {
      fetch: (opts: SearchOpts): Promise<FetchResult> => taskStore.fetch(opts),
      aggregate: (opts: AggregationOpts): Promise<estypes.SearchResponse<ConcreteTaskInstance>> =>
        taskStore.aggregate(opts),
      get: (id: string) => taskStore.get(id),
      bulkGet: (...args) => taskStore.bulkGet(...args),
      remove: (id: string) => taskStore.remove(id),
      bulkRemove: (ids: string[]) => taskStore.bulkRemove(ids),
      removeIfExists: (id: string) => removeIfExists(taskStore, id),
      schedule: (...args) => taskScheduling.schedule(...args),
      bulkSchedule: (...args) => taskScheduling.bulkSchedule(...args),
      ensureScheduled: (...args) => taskScheduling.ensureScheduled(...args),
      runSoon: (...args) => taskScheduling.runSoon(...args),
      bulkEnable: (...args) => taskScheduling.bulkEnable(...args),
      bulkDisable: (...args) => taskScheduling.bulkDisable(...args),
      bulkUpdateSchedules: (...args) => taskScheduling.bulkUpdateSchedules(...args),
      getRegisteredTypes: () => this.definitions.getAllTypes(),
      bulkUpdateState: (...args) => taskScheduling.bulkUpdateState(...args),
      registerEncryptedSavedObjectsClient: (
        client: EncryptedSavedObjectsClient,
        isEncryptionError?: (error: Error) => boolean
      ) => {
        taskStore.registerEncryptedSavedObjectsClient(client, isEncryptionError);
      },
      registerApiKeyInvalidateFn: (fn?: ApiKeyInvalidationFn) => {
        this.invalidateApiKeyFn = fn;
      },
      registerUiamApiKeyInvalidateFn: (fn?: UiamApiKeyInvalidationFn) => {
        this.invalidateUiamApiKeyFn = fn;
      },
    };

    return this.startContract;
  }

  /**
   * In `child_process` mode, lets task types with a bundle run in a process Kibana starts for each
   * run, with Kibana's own Elasticsearch connection. Without it Kibana runs every task itself,
   * which is always correct.
   */
  private startTaskProcessSupervisor() {
    const { mode, bundle_dir: bundleDir } = this.config.task_execution ?? {};
    if (mode !== 'child_process') return;
    try {
      this.taskProcessSupervisor = new TaskProcessSupervisor({
        settings: {
          bundle_dir:
            bundleDir ??
            join(
              REPO_ROOT,
              this.initContext.env.packageInfo.dist ? 'task_bundles' : 'target/task_bundles'
            ),
          kibanaVersion: this.kibanaVersion,
          getElasticsearchConfig: () => serializeElasticsearchConfig(this.elasticsearchConfig!),
          getInitFor: (taskType) => this.getTaskProcessInit?.(taskType) ?? {},
        },
        logger: this.logger,
      });
      this.taskProcessSupervisor.start();
    } catch (error) {
      this.taskProcessSupervisor = undefined;
      this.logger.error(`Task processes could not start: ${error.message}`);
    }
  }

  public async stop() {
    await this.taskProcessSupervisor?.stop();
    this.licenseSubscriber?.cleanup();
    this.claimNudgeService?.stop();

    // Stop polling for tasks
    if (this.taskPollingLifecycle) {
      this.taskPollingLifecycle.stop();
    }

    this.executionControlService?.stop();

    if (this.kibanaDiscoveryService?.isStarted()) {
      this.kibanaDiscoveryService.stop();
      try {
        await this.kibanaDiscoveryService.deleteCurrentNode();
      } catch (e) {
        this.logger.error(`Deleting current node has failed. error: ${e.message}`);
      }
    }
  }
}
