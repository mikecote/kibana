/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginInitializerContext, CoreSetup, Plugin, Logger } from '@kbn/core/server';
import { registerRoutes } from '@kbn/server-route-repository';
import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import type { APMSourcesAccessConfig } from '../common/config_schema';

import { apmIndicesSavedObjectDefinition } from './saved_objects/apm_indices';
import { createGetApmIndices } from './create_get_apm_indices';
import { APM_SOURCES_TASK_PROCESS_SETTINGS_ID } from './task_types/apm_sources_task_process_settings';
import { apmSourcesSettingsRouteRepository } from './routes';

/**
 * APM Source setup services
 */
export type ApmSourcesAccessPluginSetup = ReturnType<ApmSourcesAccessPlugin['setup']>;
/**
 * APM Source start services
 */
export type ApmSourcesAccessPluginStart = ReturnType<ApmSourcesAccessPlugin['start']>;

export interface ApmSourcesAccessPluginSetupDependencies {
  workflowsExtensions?: WorkflowsExtensionsServerPluginSetup;
}

export class ApmSourcesAccessPlugin
  implements
    Plugin<
      ApmSourcesAccessPluginSetup,
      ApmSourcesAccessPluginStart,
      ApmSourcesAccessPluginSetupDependencies
    >
{
  public config: APMSourcesAccessConfig;
  public logger: Logger;

  constructor(initContext: PluginInitializerContext) {
    this.config = initContext.config.get<APMSourcesAccessConfig>();
    this.logger = initContext.logger.get();
  }

  getApmIndices = createGetApmIndices(() => this.config.indices);

  /**
   * Registers the saved object definition and ui settings
   * for APM Sources.
   */
  public setup(core: CoreSetup, plugins: ApmSourcesAccessPluginSetupDependencies = {}) {
    plugins.workflowsExtensions?.registerTaskProcessSettings(
      APM_SOURCES_TASK_PROCESS_SETTINGS_ID,
      () => ({ indices: { ...this.config.indices } })
    );
    // register saved object
    core.savedObjects.registerType(apmIndicesSavedObjectDefinition);

    const services = {
      apmIndicesFromConfigFile: this.config.indices,
      getApmIndices: this.getApmIndices,
    };

    registerRoutes({
      core,
      logger: this.logger,
      repository: apmSourcesSettingsRouteRepository,
      runDevModeChecks: false,
      dependencies: { sources: services },
    });

    // expose
    return services;
  }

  /**
   * Initialises the user value for APM Sources UI settings.
   */
  public start() {
    return {
      getApmIndices: this.getApmIndices,
    };
  }

  public stop() {}
}
