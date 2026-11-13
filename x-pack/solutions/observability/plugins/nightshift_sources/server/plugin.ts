/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import type { FeaturesPluginStart } from '@kbn/features-plugin/server';
import { NIGHTSHIFT_FEATURE_ID } from '@kbn/nightshift-shared';
import { registerRoutes } from '@kbn/server-route-repository';
import { createSourceChangeEmitter, type SourceChangeEmitter } from './lib/source_change_emitter';
import { createSourcesClient } from './create_sources_client';
import { nightshiftSourcesRouteRepository } from './routes';
import { nightshiftSourceSavedObjectType } from './saved_objects/nightshift_source_saved_object';
import type {
  GetSourcesClient,
  NightshiftSourcesServerSetup,
  NightshiftSourcesServerStart,
} from './types';

export class NightshiftSourcesPlugin
  implements Plugin<NightshiftSourcesServerSetup, NightshiftSourcesServerStart>
{
  private readonly logger: Logger;
  private readonly isDev: boolean;
  private readonly sourceChangeEmitter: SourceChangeEmitter;

  constructor(context: PluginInitializerContext) {
    this.logger = context.logger.get();
    this.isDev = context.env.mode.dev;
    this.sourceChangeEmitter = createSourceChangeEmitter(this.logger.get('source-changes'));
  }

  public setup(
    core: CoreSetup,
    plugins: {
      workflowsExtensions?: Pick<
        WorkflowsExtensionsServerPluginSetup,
        'registerTaskProcessSettings'
      >;
    } = {}
  ): NightshiftSourcesServerSetup {
    plugins.workflowsExtensions?.registerTaskProcessSettings('nightshiftSourcesRuntime', () => ({
      enabled: true,
    }));
    core.savedObjects.registerType(nightshiftSourceSavedObjectType);

    const getSourcesClient: GetSourcesClient = async ({ request }) => {
      const [coreStart] = await core.getStartServices();
      return createSourcesClient(
        coreStart,
        request,
        this.logger.get('sources'),
        this.sourceChangeEmitter
      );
    };

    registerRoutes({
      repository: nightshiftSourcesRouteRepository,
      dependencies: { getSourcesClient },
      core,
      logger: this.logger,
      runDevModeChecks: this.isDev,
    });

    return { onSourceChange: this.sourceChangeEmitter.subscribe };
  }

  public start(
    core: CoreStart,
    plugins: { features?: FeaturesPluginStart }
  ): NightshiftSourcesServerStart {
    if (plugins.features) {
      const hasFeature = plugins.features
        .getKibanaFeatures()
        .some((f) => f.id === NIGHTSHIFT_FEATURE_ID);
      if (!hasFeature) {
        this.logger.warn(
          `The "${NIGHTSHIFT_FEATURE_ID}" feature is not registered. ` +
            'All nightshiftSources routes will return 403 because their privileges do not exist. ' +
            'Ensure the nightshift plugin is enabled alongside nightshiftSources.'
        );
      }
    }

    return {
      getSourcesClient: async ({ request }) =>
        createSourcesClient(core, request, this.logger.get('sources'), this.sourceChangeEmitter),
    };
  }

  public stop() {}
}
