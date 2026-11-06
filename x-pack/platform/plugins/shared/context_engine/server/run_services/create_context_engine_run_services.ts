/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest, Logger } from '@kbn/core/server';
import type { CoreAuditService } from '@kbn/core-security-server';
import type { SavedObjectsClientContract } from '@kbn/core-saved-objects-api-server';
import { CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { AiIndexDataReadService } from '../ai_indices/data_read_service';
import { AiIndexService } from '../ai_indices/service';
import type { AiIndexManagedBootstrap } from '../ai_indices/service';
import { ImprovementsService } from '../improvements/service';
import { SignalsService } from '../signals/service';
import type { ContextEnginePluginStart } from '../types';

export interface ContextEngineRunServicesDeps {
  /** The internal user client. */
  esClient: ElasticsearchClient;
  logger: Logger;
  savedObjects: { getScopedClient: (request: KibanaRequest) => SavedObjectsClientContract };
  uiSettings: {
    globalAsScopedToClient: (client: SavedObjectsClientContract) => {
      get: <T>(key: string) => Promise<T | undefined>;
    };
  };
  audit: Pick<CoreAuditService, 'asScoped'>;
  /** The space a request is for. */
  getSpaceId: (request: KibanaRequest) => string;
  /** The AI indices other plugins register in `setup()`: Kibana's registry, none in a process. */
  managedBootstrap?: AiIndexManagedBootstrap;
}

/**
 * What the start contract of the plugin holds besides the workflow and the feedback services: the AI
 * index service and the caller-scoped read service over it, the signals store and the improvements
 * store, built from explicit dependencies. `start()` builds them with Core's services and a task
 * process with the ones of its host.
 */
export const createContextEngineRunServices = ({
  esClient,
  logger,
  savedObjects,
  uiSettings,
  audit,
  getSpaceId,
  managedBootstrap,
}: ContextEngineRunServicesDeps): ContextEnginePluginStart & { aiIndexService: AiIndexService } => {
  const aiIndexService = new AiIndexService({
    esClient,
    logger: logger.get('ai_indices'),
    managedBootstrap,
  });
  const signalsService = new SignalsService({ esClient, logger: logger.get('signals') });
  const improvementsLogger = logger.get('improvements');
  const createImprovementsService = (client: ElasticsearchClient, spaceId: string) =>
    new ImprovementsService({ esClient: client, logger: improvementsLogger, space: spaceId });
  const createAiIndexDataReadService: ContextEnginePluginStart['getAiIndexDataReadService'] = ({
    esClient: scopedClient,
    request,
  }) =>
    new AiIndexDataReadService({
      esClient: scopedClient,
      spaceId: getSpaceId(request),
      auditLogger: audit.asScoped(request),
      aiIndexService,
      logger,
      isMemoryEnabled: async () => {
        const globalUiSettings = uiSettings.globalAsScopedToClient(
          savedObjects.getScopedClient(request)
        );
        return (
          (await globalUiSettings.get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID)) ?? false
        );
      },
    });

  return {
    aiIndexService,
    getAiIndexService: () => aiIndexService,
    getAiIndexDataReadService: createAiIndexDataReadService,
    getSignalsService: () => signalsService,
    getImprovementsService: createImprovementsService,
  };
};
