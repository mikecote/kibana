/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/server';
import { SavedObjectsClient } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import { GEN_AI_SETTINGS_TOKEN_USAGE_TRACKING } from '@kbn/management-settings-ids';
import { RegexWorkerService, getAnonymizationUiSettings } from '@kbn/ai-anonymization-server';
import { createInferenceServices } from './create_inference_services';
import { registerRoutes } from './routes';
import type { InferenceConfig } from './config';
import type {
  InferenceServerSetup,
  InferenceServerStart,
  InferenceSetupDependencies,
  InferenceStartDependencies,
} from './types';
import { InferenceEndpointIdCache } from './util/inference_endpoint_id_cache';
import { TokenUsageLogger } from './token_usage';
import { installTokenUsageDashboard } from './dashboard';

export {
  createInferenceStreamingResolver,
  resolveOnFailureMode,
  resolveReplacementsEncryptionKey,
} from './create_inference_services';

export class InferencePlugin
  implements
    Plugin<
      InferenceServerSetup,
      InferenceServerStart,
      InferenceSetupDependencies,
      InferenceStartDependencies
    >
{
  private logger: Logger;
  private config: InferenceConfig;
  private regexWorker?: RegexWorkerService;
  private endpointIdCache: InferenceEndpointIdCache;
  private tokenUsageLogger: TokenUsageLogger;

  constructor(context: PluginInitializerContext<InferenceConfig>) {
    this.logger = context.logger.get();
    this.config = context.config.get<InferenceConfig>();
    this.endpointIdCache = new InferenceEndpointIdCache();
    this.tokenUsageLogger = new TokenUsageLogger(this.logger);
  }
  setup(
    coreSetup: CoreSetup<InferenceStartDependencies, InferenceServerStart>,
    pluginsSetup: InferenceSetupDependencies
  ): InferenceServerSetup {
    coreSetup.uiSettings.register(getAnonymizationUiSettings());
    // The settings page's pattern tester runs caller-supplied regexes, which is only safe on worker
    // threads, so it follows whether this plugin runs anonymization on them.
    pluginsSetup.aiAnonymizationSettings?.configurePatternTester({
      enabled: this.config.workers.anonymization.enabled,
    });
    const router = coreSetup.http.createRouter();

    registerRoutes({
      router,
      coreSetup,
      logger: this.logger,
    });

    return {};
  }

  start(core: CoreStart, pluginsStart: InferenceStartDependencies): InferenceServerStart {
    this.endpointIdCache.setEsClient(core.elasticsearch.client.asInternalUser);
    this.tokenUsageLogger.setEsClient(core.elasticsearch.client.asInternalUser);

    const installDashboardIfTokenUsageTrackingEnabled = async () => {
      const internalRepository = core.savedObjects.createInternalRepository();
      const internalClient = new SavedObjectsClient(internalRepository);
      const uiSettingsClient = core.uiSettings.asScopedToClient(internalClient);
      const isEnabled = await uiSettingsClient.get<boolean>(GEN_AI_SETTINGS_TOKEN_USAGE_TRACKING);
      if (!isEnabled) {
        return;
      }
      const savedObjectsImporter = core.savedObjects.createImporter(internalClient);
      await installTokenUsageDashboard(savedObjectsImporter, this.logger);
    };

    installDashboardIfTokenUsageTrackingEnabled().catch((e) => {
      this.logger.error(`Failed to install token usage dashboard: ${e.message}`);
    });

    // The start contract is built by the function a task process builds it with.
    const services = createInferenceServices({
      core: {
        elasticsearch: core.elasticsearch.client,
        savedObjects: core.savedObjects,
        uiSettings: core.uiSettings,
      },
      actions: pluginsStart.actions,
      anonymization: pluginsStart.anonymization,
      logger: this.logger,
      config: this.config,
      regexWorker: new RegexWorkerService(
        this.config.workers.anonymization,
        this.logger.get('regex_worker')
      ),
      endpointIdCache: this.endpointIdCache,
      tokenUsageLogger: this.tokenUsageLogger,
    });
    this.regexWorker = services.regexWorker;

    return {
      ...services.contract,
      installTokenUsageDashboard: async () => {
        const internalRepository = core.savedObjects.createInternalRepository();
        const internalClient = new SavedObjectsClient(internalRepository);
        const savedObjectsImporter = core.savedObjects.createImporter(internalClient);
        await installTokenUsageDashboard(savedObjectsImporter, this.logger);
      },
    };
  }

  async stop() {
    await this.regexWorker?.stop();
  }
}
