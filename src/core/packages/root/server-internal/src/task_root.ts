/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { firstValueFrom } from 'rxjs';
import { ConfigService, type Env, type RawConfigurationProvider } from '@kbn/config';
import { ensureValidConfiguration } from '@kbn/core-config-server-internal';
import { AnalyticsService } from '@kbn/core-analytics-server-internal';
import {
  LoggingSystem,
  LoggingService,
  type LoggingConfigType,
} from '@kbn/core-logging-server-internal';
import { EnvironmentService } from '@kbn/core-environment-server-internal';
import { NodeService } from '@kbn/core-node-server-internal';
import { ElasticsearchService } from '@kbn/core-elasticsearch-server-internal';
import { DataStreamsService } from '@kbn/core-data-streams-server-internal';
import { SavedObjectsService } from '@kbn/core-saved-objects-server-internal';
import { UiSettingsService } from '@kbn/core-ui-settings-server-internal';
import { SecurityService } from '@kbn/core-security-server-internal';
import { UserProfileService } from '@kbn/core-user-profile-server-internal';
import { ExecutionContextService } from '@kbn/core-execution-context-server-internal';
import { DocLinksService } from '@kbn/core-doc-links-server-internal';
import { StatusService } from '@kbn/core-status-server-internal';
import { TaskHttpService } from '@kbn/core-http-server-internal';
import {
  PluginsService,
  type TaskStaticPlugin,
  type TaskCoreSetupServices,
} from '@kbn/core-plugins-server-internal';
import { registerTaskServiceConfig } from './task_service_config';
import { configureSelfClientSecurity } from './configure_self_client_security';
import { coreConfig, type CoreConfigType } from './core_config';

/** Boots Core's service and static-plugin lifecycles without web-server services. */
export class TaskRoot {
  private readonly loggingSystem = new LoggingSystem();
  public readonly logger = this.loggingSystem.asLoggerFactory();
  private readonly configService: ConfigService;
  private readonly analytics: AnalyticsService;
  private readonly logging: LoggingService;
  private readonly environment: EnvironmentService;
  private readonly node: NodeService;
  private readonly elasticsearch: ElasticsearchService;
  private readonly savedObjects: SavedObjectsService;
  private readonly dataStreams: DataStreamsService;
  private readonly uiSettings: UiSettingsService;
  private readonly security: SecurityService;
  private readonly userProfile: UserProfileService;
  private readonly executionContext: ExecutionContextService;
  private readonly docLinks: DocLinksService;
  private readonly status: StatusService;
  private readonly http: TaskHttpService;
  private readonly plugins: PluginsService;
  private setupServices?: TaskCoreSetupServices;
  private pluginDependencies: ReadonlyMap<string, string[]> = new Map();
  private shuttingDown = false;

  constructor(
    rawConfigProvider: RawConfigurationProvider,
    env: Env,
    staticPlugins: readonly TaskStaticPlugin[]
  ) {
    this.loggingSystem.setGlobalContext({
      service: {
        version:
          env.packageInfo.buildFlavor === 'serverless'
            ? env.packageInfo.buildShaShort
            : env.packageInfo.version,
        type: 'kibana',
        state: 'initializing',
      },
    });
    this.configService = new ConfigService(rawConfigProvider, env, this.logger);
    const core = {
      coreId: Symbol('task-core'),
      configService: this.configService,
      env,
      logger: this.logger,
    };
    this.analytics = new AnalyticsService(core);
    this.logging = new LoggingService(core);
    this.environment = new EnvironmentService(core);
    this.node = new NodeService(core);
    this.elasticsearch = new ElasticsearchService(core);
    this.savedObjects = new SavedObjectsService(core);
    this.dataStreams = new DataStreamsService(core);
    this.uiSettings = new UiSettingsService(core);
    this.security = new SecurityService(core);
    this.userProfile = new UserProfileService(core);
    this.executionContext = new ExecutionContextService(core);
    this.docLinks = new DocLinksService(core);
    this.status = new StatusService(core);
    this.http = new TaskHttpService(core);
    this.plugins = new PluginsService(core, { staticPlugins });
  }

  public async preboot(): Promise<void> {
    registerTaskServiceConfig(this.configService);
    await this.loggingSystem.upgrade(
      await firstValueFrom(this.configService.atPath<LoggingConfigType>('logging'))
    );
    this.logging.preboot({ loggingSystem: this.loggingSystem });
    const environment = await this.environment.preboot({ analytics: this.analytics.preboot() });
    const node = await this.node.preboot({ loggingSystem: this.loggingSystem });
    const discovered = await this.plugins.discover({ environment, node });
    this.pluginDependencies = discovered.standard.pluginTree.asNames;
    await this.uiSettings.preboot();
  }

  public async setup(): Promise<void> {
    try {
      await ensureValidConfiguration(this.configService);
    } catch (error) {
      const config = await firstValueFrom(
        this.configService.atPath<CoreConfigType>(coreConfig.path)
      );
      if (!config.enableStripUnknownConfigWorkaround) throw error;
      this.configService.setGlobalStripUnknownKeys(true);
      await ensureValidConfiguration(this.configService, {
        logDeprecations: true,
        stripUnknownKeys: true,
      });
    }
    const security = this.security.setup();
    const elasticsearch = await this.elasticsearch.setup({
      analytics: this.analytics.setup(),
      executionContext: this.executionContext.setup(),
      security,
      http: await this.http.setup(),
      loggingSystem: this.loggingSystem,
    });
    const savedObjects = await this.savedObjects.setupTask({ elasticsearch });
    this.setupServices = {
      analytics: this.analytics.setup(),
      elasticsearch,
      logging: this.logging.setup(),
      savedObjects,
      dataStreams: await this.dataStreams.setup(),
      uiSettings: await this.uiSettings.setupTask({ savedObjects }),
      security,
      userProfile: this.userProfile.setup(),
      status: await this.status.setupTask({
        analytics: this.analytics.setup(),
        elasticsearch,
        savedObjects,
        pluginDependencies: this.pluginDependencies,
        loggingSystem: this.loggingSystem,
      }),
    };
    this.docLinks.setup();
    await this.plugins.setupTask(this.setupServices);
  }

  public async start(): Promise<void> {
    if (!this.setupServices) throw new Error('Task Core must be set up before start.');
    const security = this.security.start();
    const elasticsearch = await this.elasticsearch.start();
    const savedObjects = await this.savedObjects.start({
      elasticsearch,
      docLinks: this.docLinks.start(),
      node: await this.node.start(),
    });
    const http = this.http.start();
    configureSelfClientSecurity(http, security);
    this.status.start();
    await this.plugins.startTask({
      analytics: this.analytics.start(),
      elasticsearch,
      executionContext: this.executionContext.start(),
      savedObjects,
      dataStreams: await this.dataStreams.start({ elasticsearch }),
      uiSettings: await this.uiSettings.start(),
      security,
      userProfile: this.userProfile.start(),
      http,
    });
  }

  public async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.plugins.stop();
    await this.uiSettings.stop();
    this.dataStreams.stop();
    await this.savedObjects.stop();
    await this.elasticsearch.stop();
    await this.http.stop();
    this.security.stop();
    this.userProfile.stop();
    this.node.stop();
    this.status.stop();
    await this.analytics.stop();
    this.logging.stop();
    await this.loggingSystem.stop();
  }
}
