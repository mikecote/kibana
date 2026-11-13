/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { WorkflowRulesReadServices } from '@kbn/alerting-plugin/server/task_types/create_workflow_rules_read_client';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { FieldsMetadataServerStart } from '@kbn/fields-metadata-plugin/server';
import { registerStreamsAgentBuilder } from '../agent_builder/register';
import { getStreamsToolAvailabilityFromServices } from '../agent_builder/utils/get_streams_tool_availability';
import { createStreamsRunServices } from '../create_streams_run_services';
import type { StreamsStartServicesAccess } from '../start_services_access';

/** The id of the settings the plugin sends a task process: only when streams registers with agent builder in this Kibana. */
export const STREAMS_AGENT_BUILDER_SETTINGS_ID = 'streamsAgentBuilder';

export interface StreamsAgentBuilderSettings {
  isDev: boolean;
  canvasEnabled: boolean;
  canEncrypt: boolean;
  isServerless: boolean;
}

/** Registers Streams tools over the same scoped native client factories used in Main. */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [STREAMS_AGENT_BUILDER_SETTINGS_ID] },
  register: async (agentBuilder, { host, logger, settings, services }) => {
    const streamsSettings = settings[STREAMS_AGENT_BUILDER_SETTINGS_ID] as
      | StreamsAgentBuilderSettings
      | undefined;
    if (!streamsSettings) return;

    const taskHost = host as TaskHost;
    const streamsLogger = logger.get('streams');

    const core: StreamsStartServicesAccess = {
      getStartServices: async () => {
        const uiSettings = taskHost.uiSettings;
        if (!uiSettings) throw new Error('Native Streams requires UI settings');
        const licensing = taskHost.licensing;
        if (!licensing) throw new Error('The task process did not get the license');
        const encryptedSavedObjects = taskHost.encryptedSavedObjects;
        if (!encryptedSavedObjects)
          throw new Error('Native Streams requires encrypted saved objects');
        return [
          {
            elasticsearch: {
              client: taskHost.elasticsearch,
              getCapabilities: () => ({ serverless: streamsSettings.isServerless }),
            },
            savedObjects: taskHost.savedObjects,
            uiSettings,
          },
          {
            encryptedSavedObjects,
            inference: services.getInferenceStart() as InferenceServerStart,
            licensing: { getLicense: () => firstValueFrom(licensing.license$) },
            fieldsMetadata: services.getService<FieldsMetadataServerStart>('fieldsMetadata'),
            alerting: services.getService<WorkflowRulesReadServices>('alerting'),
          },
        ] as const;
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
