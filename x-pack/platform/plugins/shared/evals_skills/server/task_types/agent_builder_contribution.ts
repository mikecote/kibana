/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import {
  createListEvaluators,
  createListModelConnectors,
} from '@kbn/evals-plugin/server/create_evals_read_services';
import { createEvaluatorRegistry } from '@kbn/evals-plugin/server/evaluators/registry';
import { DatasetService } from '@kbn/evals-plugin/server/storage/datasets/dataset_service';
import { EvaluatorDefinitionService } from '@kbn/evals-plugin/server/storage/evaluators/evaluator_definition_service';
import { registerEvalsSkillsAgentBuilder } from '../register_agent_builder';
import type { EvalsSkillsStartDependencies } from '../types';

/** The id of the settings the plugin sends a task process: only when the evals feature is enabled in this Kibana. */
export const EVALS_SKILLS_AGENT_BUILDER_SETTINGS_ID = 'evalsSkillsAgentBuilder';

export interface EvalsSkillsAgentBuilderSettings {
  serverBasePath: string;
  isServerless: boolean;
}

/**
 * What the evals skills register with agent builder, in the task process of the workflow task types:
 * the experiments and the dataset management skills, which `setup()` registers with the same function.
 * The evals services they read are built from explicit dependencies as the plugin builds them at start:
 * the dataset service over Elasticsearch, the evaluator registry (the built-in evaluators and the
 * persisted definitions) and the connectors a request may use as models, from the inference service of
 * the process. The workflows API is the one of the process: the dataset tools and listing work; saving
 * an experiment (creating or updating a workflow) is Kibana's workflows service and throws "only
 * available in Kibana", while running one goes through `scheduleWorkflow`.
 */
export const contribution: AgentBuilderContribution = {
  declares: { settings: [EVALS_SKILLS_AGENT_BUILDER_SETTINGS_ID] },
  register: (agentBuilder, { host, logger, settings, services }) => {
    const skillsSettings = settings[EVALS_SKILLS_AGENT_BUILDER_SETTINGS_ID] as
      | EvalsSkillsAgentBuilderSettings
      | undefined;
    if (!skillsSettings) return;

    const { elasticsearch, plugins } = host as TaskHost;
    const evalsLogger = logger.get('evals');

    let startDependencies: EvalsSkillsStartDependencies | undefined;
    const getStartDependencies = async () => {
      if (!startDependencies) {
        const esClient = elasticsearch.asInternalUser;
        // The registry resolves persisted definitions through the service, which asks the registry
        // whether a name is built in.
        // eslint-disable-next-line prefer-const
        let definitionService: EvaluatorDefinitionService;
        const evaluatorRegistry = createEvaluatorRegistry({
          getDefinitionClient: ({ spaceId }) => definitionService.getClient({ spaceId }),
        });
        definitionService = new EvaluatorDefinitionService(
          evalsLogger,
          esClient,
          skillsSettings.isServerless,
          evaluatorRegistry.isBuiltIn
        );
        const security = (plugins?.security as SecurityTaskPluginStart | undefined)?.authz
          ? ({
              authz: (plugins?.security as SecurityTaskPluginStart).authz,
            } as unknown as SecurityPluginStart)
          : undefined;
        startDependencies = {
          agentBuilder: services.getAgentBuilderStart(),
          evals: {
            datasetService: new DatasetService(evalsLogger, esClient, skillsSettings.isServerless),
            listEvaluators: createListEvaluators(evaluatorRegistry),
            listModelConnectors: createListModelConnectors((request) =>
              (services.getInferenceStart() as InferenceServerStart).getConnectorList(request)
            ),
          },
          security,
        };
      }
      return startDependencies;
    };

    registerEvalsSkillsAgentBuilder(agentBuilder, {
      workflowsApi: services.getWorkflowsManagement() as WorkflowsServerPluginSetup['management'],
      serverBasePath: skillsSettings.serverBasePath,
      logger: evalsLogger,
      getStartDependencies,
    });
  },
};
