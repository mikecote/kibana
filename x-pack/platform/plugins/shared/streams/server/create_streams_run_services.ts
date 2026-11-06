/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { RulesClientCreateOptions } from '@kbn/alerting-plugin/server';
import {
  STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE,
  STREAMS_UI_METADATA_SAVED_OBJECT_TYPE,
} from '../common/constants';
import { AttachmentService } from './lib/streams/attachments/attachment_service';
import { StreamsService } from './lib/streams/service';
import { ContentService } from './lib/content/content_service';
import { createStreamsSettingsStorageClient } from './lib/streams/storage/streams_settings_storage_client';
import type { GetScopedClients, RouteHandlerScopedClients } from './routes/types';
import type { StreamsStartServicesAccess } from './start_services_access';

/**
 * The services over streams' storage and the scoped clients the routes and the agent builder tools
 * read, built from what they read of Core and the plugins at start. Kibana's `setup()` calls it with
 * `core`, and a task process with its own start services, so that both build the same clients.
 */
export const createStreamsRunServices = ({
  core,
  logger,
  isDev,
  canvasEnabled,
  canEncrypt,
}: {
  core: StreamsStartServicesAccess;
  logger: Logger;
  isDev: boolean;
  /** `xpack.streams.canvas.enabled`: the saved object types of canvas are included in the clients. */
  canvasEnabled: boolean;
  canEncrypt: boolean;
}) => {
  const attachmentService = new AttachmentService(core, logger);
  const streamsService = new StreamsService(core, logger, isDev);
  const contentService = new ContentService(core, logger);

  const getScopedClients: GetScopedClients = async ({
    request,
    rulesClientOptions,
  }: {
    request: KibanaRequest;
    rulesClientOptions?: RulesClientCreateOptions;
  }): Promise<RouteHandlerScopedClients> => {
    const [coreStart, pluginsStart] = await core.getStartServices();

    const scopedSoClient = coreStart.savedObjects.getScopedClient(request, {
      includedHiddenTypes: canvasEnabled
        ? [STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE, STREAMS_UI_METADATA_SAVED_OBJECT_TYPE]
        : [],
    });
    const encryptedSavedObjectsClient = pluginsStart.encryptedSavedObjects.getClient({
      includedHiddenTypes: canvasEnabled ? [STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE] : [],
    });
    const uiSettingsClient = coreStart.uiSettings.asScopedToClient(scopedSoClient);
    const globalUiSettingsClient = coreStart.uiSettings.globalAsScopedToClient(scopedSoClient);

    const scopedClusterClient = coreStart.elasticsearch.client.asScoped(request);
    const soClient = scopedSoClient;
    const inferenceClient = pluginsStart.inference.getClient({ request });
    const licensing = pluginsStart.licensing;
    const fieldsMetadataClient = await pluginsStart.fieldsMetadata.getClient(request);
    const [attachmentClient, contentClient] = await Promise.all([
      attachmentService.getClient({
        soClient,
        rulesClient: await pluginsStart.alerting.getRulesClientWithRequest(request),
      }),
      contentService.getClient(),
    ]);

    const license = await licensing.getLicense();
    const isSecurityEnabled = license.getFeature('security').isEnabled;

    const streamsClient = await streamsService.getClient({
      attachmentClient,
      esClient: scopedClusterClient.asCurrentUser,
      esClientAsInternalUser: coreStart.elasticsearch.client.asInternalUser,
      uiSettingsClient,
      isSecurityEnabled,
    });

    const streamsSettingsStorageClient = createStreamsSettingsStorageClient(
      coreStart.elasticsearch.client.asInternalUser,
      logger
    );

    return {
      scopedClusterClient,
      soClient,
      encryptedSavedObjectsClient,
      canEncrypt,
      attachmentClient,
      streamsClient,
      inferenceClient,
      contentClient,
      fieldsMetadataClient,
      licensing,
      uiSettingsClient,
      globalUiSettingsClient,
      streamsSettingsStorageClient,
      isSecurityEnabled,
    };
  };

  return { attachmentService, streamsService, contentService, getScopedClients };
};
