/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Subject } from 'rxjs';
import type { PluginInitializerContext, CoreStart, Plugin, Logger } from '@kbn/core/server';
import { registerRoutes } from './routes';
import type {
  EntityStoreCoreSetup,
  EntityStoreRequestHandlerContext,
  EntityStoreSetupPlugins,
  EntityStoreStartPlugins,
  EntityStoreStartContract,
  EntityStoreSetupContract,
} from './types';
import { createRequestHandlerContext } from './request_context_factory';
import { PLUGIN_ID } from '../common';
import { registerTasks } from './tasks/register_tasks';
import { scheduleLegacySecurityAssetsMigrationIfNeeded } from './tasks/legacy_security_assets_migration_task';
import { registerTriggers } from './workflow/triggers';
import { registerSteps } from './workflow/steps';
import { registerUiSettings } from './infra/feature_flags/register';
import {
  EngineDescriptorType,
  EntityStoreGlobalStateType,
  EntityStorePreferencesType,
  LegacyCcsLogExtractionStateType,
  LegacyRemoteLogExtractionStateType,
} from './domain/saved_objects';
import { EntityResolutionRuleType } from './domain/resolution/rules/saved_object';
import { CustomResolutionRuleType } from './domain/resolution/rules';
import { registerEntityMaintainerTask } from './tasks/entity_maintainers';
import type { RegisterEntityMaintainerConfig } from './tasks/entity_maintainers/types';
import { createEntityStoreRunServices } from './entity_store_run_services';
import {
  createEntityStoreClientServices,
  ENTITY_STORE_RUNTIME_SETTINGS_ID,
} from './create_entity_store_client_services';
import { entityMaintainersRegistry } from './tasks/entity_maintainers/entity_maintainers_registry';
import { registerTelemetry, createReportEvent } from './telemetry/events';
import { registerEntityStoreUsageCollector } from './telemetry/usage_collector';
import { automatedResolutionMaintainerConfig } from './domain/resolution/rules/maintainers/automated_resolution';
import {
  subscribeToDualProcessFlag,
  subscribeToLegacySecurityAssetsMigrationFlag,
} from './infra/feature_flags';
import {
  EntityDefinitionRegistry,
  createEntityDefinitionsClient,
} from './domain/definitions/registry';
import { userEntityDefinition } from '../common/domain/definitions/user';
import { hostEntityDefinition } from '../common/domain/definitions/host';
import { serviceEntityDefinition } from '../common/domain/definitions/service';
import { genericEntityDefinition } from '../common/domain/definitions/generic';

export class EntityStorePlugin
  implements
    Plugin<
      EntityStoreSetupContract,
      EntityStoreStartContract,
      EntityStoreSetupPlugins,
      EntityStoreStartPlugins
    >
{
  private readonly logger: Logger;
  private readonly isServerless: boolean;
  private readonly stop$ = new Subject<void>();
  private readonly entityDefinitionRegistry: EntityDefinitionRegistry;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
    this.entityDefinitionRegistry = new EntityDefinitionRegistry(
      this.logger.get('entity_definition_registry')
    );
    this.isServerless = initializerContext.env.packageInfo.buildFlavor === 'serverless';
  }

  public setup(
    core: EntityStoreCoreSetup,
    plugins: EntityStoreSetupPlugins
  ): EntityStoreSetupContract {
    plugins.taskManager.registerCanEncryptedSavedObjects(plugins.encryptedSavedObjects.canEncrypt);

    this.registerBuiltInEntityDefinitions();

    this.logger.debug('Registering telemetry events');
    registerTelemetry(core.analytics);
    if (plugins.usageCollection) {
      registerEntityStoreUsageCollector(plugins.usageCollection);
    }

    const router = core.http.createRouter<EntityStoreRequestHandlerContext>();
    core.http.registerRouteHandlerContext<EntityStoreRequestHandlerContext, typeof PLUGIN_ID>(
      PLUGIN_ID,
      (context, request) =>
        createRequestHandlerContext({
          context,
          coreSetup: core,
          logger: this.logger,
          request,
          isServerless: this.isServerless,
          analytics: createReportEvent(core.analytics),
        })
    );

    registerTasks(plugins.taskManager, this.logger, core, this.isServerless);
    registerTriggers(plugins.workflowsExtensions);
    registerSteps(plugins.workflowsExtensions, core);
    plugins.workflowsExtensions.registerTaskProcessSettings(
      ENTITY_STORE_RUNTIME_SETTINGS_ID,
      () => ({
        maintainers: entityMaintainersRegistry.getAll(),
      })
    );
    this.logger.debug('Registering routes');
    registerRoutes(router);

    this.logger.debug('Registering ui settings');
    registerUiSettings(core.uiSettings);

    this.logger.debug('Registering saved objects types');
    core.savedObjects.registerType(EngineDescriptorType);
    core.savedObjects.registerType(EntityStoreGlobalStateType);
    core.savedObjects.registerType(EntityStorePreferencesType);
    core.savedObjects.registerType(LegacyRemoteLogExtractionStateType);
    core.savedObjects.registerType(LegacyCcsLogExtractionStateType);
    core.savedObjects.registerType(EntityResolutionRuleType);
    core.savedObjects.registerType(CustomResolutionRuleType);

    registerEntityMaintainerTask({
      taskManager: plugins.taskManager,
      logger: this.logger,
      config: automatedResolutionMaintainerConfig,
      core,
      analytics: createReportEvent(core.analytics),
    });

    return {
      registerEntityMaintainer: (config: RegisterEntityMaintainerConfig) =>
        registerEntityMaintainerTask({
          taskManager: plugins.taskManager,
          logger: this.logger,
          config,
          core,
          analytics: createReportEvent(core.analytics),
        }),
      registerEntityDefinition: (definition) => this.entityDefinitionRegistry.register(definition),
    };
  }

  public start(core: CoreStart, plugins: EntityStoreStartPlugins): EntityStoreStartContract {
    // Kibana starts plugins only after every plugin's setup has finished, so code registration closes here.
    this.entityDefinitionRegistry.closeSetupRegistration();
    this.logger.info('Initializing plugin');

    plugins.taskManager.registerEncryptedSavedObjectsClient(
      plugins.encryptedSavedObjects.getClient({
        includedHiddenTypes: ['task', 'api_key_to_invalidate'],
      })
    );

    plugins.taskManager.registerApiKeyInvalidateFn(
      plugins.security?.authc.apiKeys.invalidateAsInternalUser
    );

    subscribeToLegacySecurityAssetsMigrationFlag({
      coreStart: core,
      logger: this.logger,
      stop$: this.stop$,
      scheduleMigration: () =>
        scheduleLegacySecurityAssetsMigrationIfNeeded({
          coreStart: core,
          taskManager: plugins.taskManager,
          logger: this.logger,
        }),
    });

    subscribeToDualProcessFlag({
      coreStart: core,
      logger: this.logger,
      stop$: this.stop$,
    });

    const { logger, entityDefinitionRegistry } = this;
    return {
      ...createEntityStoreRunServices({ logger }),
      ...createEntityStoreClientServices({
        logger,
        analytics: core.analytics,
        taskManager: plugins.taskManager,
        getMaintainers: () => entityMaintainersRegistry.getAll(),
      }),
      getEntityDefinitionsClient: (request) =>
        createEntityDefinitionsClient(
          entityDefinitionRegistry,
          plugins.spaces.spacesService.getSpaceId(request)
        ),
      getEntityDefinitionsClientForSpace: (spaceId) =>
        createEntityDefinitionsClient(entityDefinitionRegistry, spaceId),
    };
  }

  private registerBuiltInEntityDefinitions(): void {
    const builtIns = [
      userEntityDefinition,
      hostEntityDefinition,
      serviceEntityDefinition,
      genericEntityDefinition,
    ];
    // Rejections are logged by the registry itself; there is nothing to add here.
    builtIns.forEach((definition) => this.entityDefinitionRegistry.register(definition));
  }

  public stop() {
    this.logger.info('Stopping plugin');
    this.stop$.next();
    this.stop$.complete();
  }
}
