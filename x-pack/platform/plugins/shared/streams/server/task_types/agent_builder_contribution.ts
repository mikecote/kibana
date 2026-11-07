/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import type { KibanaRequest } from '@kbn/core/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { FieldsMetadataService } from '@kbn/fields-metadata-plugin/server/services/fields_metadata/fields_metadata_service';
import { registerStreamsAgentBuilder } from '../agent_builder/register';
import { getStreamsToolAvailabilityFromServices } from '../agent_builder/utils/get_streams_tool_availability';
import { createStreamsRunServices } from '../create_streams_run_services';
import { registerFieldsMetadataExtractors } from '../register_fields_metadata_extractors';
import type { StreamsStartServicesAccess } from '../start_services_access';

/** The id of the settings the plugin sends a task process: only when streams registers with agent builder in this Kibana. */
export const STREAMS_AGENT_BUILDER_SETTINGS_ID = 'streamsAgentBuilder';

export interface StreamsAgentBuilderSettings {
  isDev: boolean;
  canvasEnabled: boolean;
  canEncrypt: boolean;
  isServerless: boolean;
}

/** What a service of streams reads and a process cannot have: it throws when something uses it. */
const onlyInKibana = (what: string): never =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'then') return undefined;
        return () => {
          throw new Error(`${what} is only available in Kibana`);
        };
      },
    }
  ) as never;

/**
 * What streams registers with agent builder, in the task process of the workflow task types: its
 * tools and its skill, which `setup()` registers with the same function. The scoped clients are the
 * ones of `createStreamsRunServices` over the host of the process (Core's Elasticsearch, saved objects
 * and ui settings, the process's inference, the license and the fields metadata service, started
 * with the streams extractor).
 *
 * Differences from Kibana: the rules client of alerting (which the attachment client uses to read and
 * link rules to streams) and the encrypted saved objects client (canvas configuration, which no tool
 * reads) exist only in Kibana, and throw when used; integration fields (from Fleet) are not served;
 * tool availability uses the shared authorized Spaces service and native solution gate.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [STREAMS_AGENT_BUILDER_SETTINGS_ID] },
  register: async (agentBuilder, { host, logger, settings, services }) => {
    const streamsSettings = settings[STREAMS_AGENT_BUILDER_SETTINGS_ID] as
      | StreamsAgentBuilderSettings
      | undefined;
    if (!streamsSettings) return;

    const taskHost = host as TaskHost;
    const streamsLogger = logger.get('streams');

    let fieldsMetadata: ReturnType<FieldsMetadataService['start']> | undefined;
    const getFieldsMetadata = () => {
      if (!fieldsMetadata) {
        const service = new FieldsMetadataService(streamsLogger.get('fieldsMetadata'));
        registerFieldsMetadataExtractors({
          fieldsMetadata: service.setup() as never,
          logger: streamsLogger,
        });
        fieldsMetadata = service.start({
          capabilities: { resolveCapabilities: async () => ({ fleet: {}, fleetv2: {} }) },
          elasticsearch: { client: taskHost.elasticsearch },
        } as never);
      }
      return fieldsMetadata;
    };

    const core: StreamsStartServicesAccess = {
      getStartServices: async () => {
        const coreStart = await services.getCoreStart();
        const licensing = taskHost.licensing;
        if (!licensing) throw new Error('The task process did not get the license');
        return [
          {
            elasticsearch: {
              client: taskHost.elasticsearch,
              getCapabilities: () => ({ serverless: streamsSettings.isServerless }),
            },
            savedObjects: taskHost.savedObjects,
            uiSettings: coreStart.uiSettings,
          },
          {
            encryptedSavedObjects: { getClient: () => onlyInKibana('Encrypted saved objects') },
            inference: {
              getClient: ({ request }: { request: KibanaRequest }) =>
                (services.getInferenceStart() as InferenceServerStart).getClient({ request }),
            },
            licensing: { getLicense: () => firstValueFrom(licensing.license$) },
            fieldsMetadata: {
              getClient: (request: KibanaRequest) => getFieldsMetadata().getClient(request),
            },
            alerting: { getRulesClientWithRequest: async () => onlyInKibana('The rules client') },
          },
        ] as never;
      },
    };

    const { getScopedClients } = createStreamsRunServices({
      core,
      logger: streamsLogger,
      isDev: streamsSettings.isDev,
      canvasEnabled: streamsSettings.canvasEnabled,
      canEncrypt: streamsSettings.canEncrypt,
    });

    await registerStreamsAgentBuilder(agentBuilder, {
      getScopedClients,
      server: { isServerless: streamsSettings.isServerless },
      logger: streamsLogger,
      availability: {
        cacheMode: 'space',
        handler: ({ request }) =>
          getStreamsToolAvailabilityFromServices({
            spaces: services.getService<SpacesPluginStart>('spaces'),
            logger: streamsLogger,
            request,
          }),
      },
    });
  },
};
