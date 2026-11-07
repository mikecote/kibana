/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { SecurityPluginSetup } from '@kbn/security-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import {
  CHAT_ATTACHMENT_IMAGES_FILE_KIND,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
} from '@kbn/agent-builder-common/attachments';
import {
  createFilesRunServices,
  filesRunSavedObjectTypes,
} from '@kbn/files-plugin/server/create_files_run_services';
import { createLlmTasksStartContract } from '@kbn/llm-tasks-plugin/server/create_llm_tasks_start_contract';
import {
  createProductDocReadServices,
  productDocReadSavedObjectTypes,
} from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import { registerAgentBuilderPlatform } from '../register_agent_builder';
import { registerAgentBuilderPlatformSml } from '../sml_types/register_sml';
import type { AgentBuilderPlatformCoreSetup } from '../types';

/** The id of the settings the plugin sends a task process. */
export const AGENT_BUILDER_PLATFORM_SETTINGS_ID = 'agentBuilderPlatform';

export interface AgentBuilderPlatformTaskProcessSettings {
  /** The organization of the cloud deployment, which `generate_esql` sends with its requests. */
  organizationId?: string;
  /** Whether Kibana has the LLM tasks plugin: without it the product documentation tool answers "not available". */
  llmTasks?: boolean;
}

/**
 * What the plugin registers with agent builder, in the task process of the workflow task types:
 * listed under `taskTypeContributions['agent-builder']` in `kibana.jsonc`. The registrations are the
 * ones `setup()` makes, with the services of the process in place of Kibana's start services: the
 * LLM tasks (`createLlmTasksStartContract` over the inference services of the process and the product
 * documentation read services) and the file service (`createFilesRunServices`, with the file kind of the
 * chat images) the product documentation tool and the image attachment type read.
 *
 * Differences from Kibana: the product documentation counts as installed from the status saved objects
 * (an installation in flight is not looked at), and Security Labs is not available.
 */
export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [AGENT_BUILDER_PLATFORM_SETTINGS_ID],
    savedObjectTypes: [...filesRunSavedObjectTypes, ...productDocReadSavedObjectTypes],
  },
  register: (agentBuilder, { host, logger, settings, services, registerSmlType }) => {
    // Without the setting the plugin is not enabled in this Kibana, and nothing is registered.
    const sent = settings[AGENT_BUILDER_PLATFORM_SETTINGS_ID] as
      | AgentBuilderPlatformTaskProcessSettings
      | undefined;
    if (!sent) return;
    const { organizationId } = sent;
    const taskHost = host as TaskHost;
    const { basePath } = taskHost.http;

    // Built when first read: the host is complete by the time a tool runs.
    let llmTasks: ReturnType<typeof createLlmTasksStartContract> | undefined;
    const getLlmTasks = () => {
      if (!sent.llmTasks) return undefined;
      if (!llmTasks) {
        llmTasks = createLlmTasksStartContract({
          inference: services.getInferenceStart() as InferenceServerStart,
          productDocBase: {
            ...(() => {
              const read = createProductDocReadServices({
                esClient: taskHost.elasticsearch.asInternalUser,
                createInternalRepository: (types) =>
                  taskHost.savedObjects.createInternalRepository(types),
                logger: logger.get('productDocBase'),
              });
              return { search: read.search, management: read };
            })(),
          },
          logger: logger.get('llmTasks'),
        });
      }
      return llmTasks;
    };
    let files: ReturnType<typeof createFilesRunServices> | undefined;
    const getFiles = () => {
      if (!files) {
        files = createFilesRunServices({
          savedObjects: taskHost.savedObjects as never,
          esClient: taskHost.elasticsearch.asInternalUser,
          security: taskHost.security as unknown as SecurityPluginSetup,
          logger: logger.get('files'),
          fileKinds: [
            {
              id: CHAT_ATTACHMENT_IMAGES_FILE_KIND,
              allowedMimeTypes: [...SUPPORTED_IMAGE_MIME_TYPES],
              maxSizeBytes: MAX_IMAGE_BYTES,
              http: {},
            },
          ],
        });
      }
      return files;
    };

    const coreSetup: AgentBuilderPlatformCoreSetup = {
      getStartServices: async () => [
        await services.getCoreStart(),
        {
          agentBuilder: services.getAgentBuilderStart(),
          actions: (await services.getActionsStart()) as ActionsPluginStart,
          files: getFiles(),
          llmTasks: getLlmTasks(),
        },
        {},
      ],
      http: { basePath: { get: (request) => basePath.get(request) } },
    };

    registerAgentBuilderPlatform(agentBuilder, {
      coreSetup,
      logger: logger.get('agentBuilderPlatform'),
      organizationId,
    });
    registerAgentBuilderPlatformSml(
      { registerType: registerSmlType },
      { getCoreStart: services.getCoreStart, logger: logger.get('agentBuilderPlatform') }
    );
  },
};
