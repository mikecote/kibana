/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createServerUrlService } from '@kbn/share-plugin/server';
import type { SharePluginStart } from '@kbn/share-plugin/server';
import type { StandaloneSearch } from '@kbn/data-plugin/server/search/standalone_search';
import { querySavedObjectType } from '@kbn/data-plugin/server/saved_objects/query';
import {
  exceptionListType,
  exceptionListAgnosticType,
  LISTS_TASK_PROCESS_SETTINGS_ID,
} from '@kbn/lists-plugin/server';
import { RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID } from '@kbn/rule-registry-plugin/server';
import type { EncryptedSavedObjectsPluginSetup } from '@kbn/encrypted-saved-objects-plugin/server';
import type { FleetWorkflowRunServices } from '@kbn/fleet-plugin/server/services/run_time/workflow_run_services';
import type { DataViewsServerPluginStart } from '@kbn/data-views-plugin/server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { WorkflowRulesReadServices } from '@kbn/alerting-plugin/server/task_types/create_workflow_rules_read_client';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { ProductDocReadSettings } from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import {
  createMitreAttackRunServices,
  mitreAttackEntityType,
} from '@kbn/mitre-attack-plugin/server/create_mitre_attack_run_services';
import { firstValueFrom } from 'rxjs';
import { createLlmTasksRunServices } from '@kbn/llm-tasks-plugin/server/create_llm_tasks_run_services';
import {
  PRODUCT_DOC_READ_SETTINGS_ID,
  productDocReadSavedObjectTypes,
} from '@kbn/product-doc-base-plugin/server/create_product_doc_read_services';
import { registerTools } from '../agent_builder/tools/register_tools';
import { createSecurityPreviewRunServices } from './create_security_preview_run_services';
import type { LazyRunRulePreviewDeps } from '../lib/detection_engine/rule_preview/api/preview_rules/run_rule_preview';
import type { RulePreviewServices } from '../lib/detection_engine/rule_preview/rule_preview_services';
import { TASK_PROCESS_SETTINGS_ID } from '../config';
import { prebuiltRuleAssetType } from '../lib/detection_engine/prebuilt_rules';
import { getSecurityRuleRunUiSettings } from '../ui_settings';
import { registerSkills } from '../agent_builder/skills/register_skills';
import type { SecuritySkillServices } from '../agent_builder/skills/services';
import type { SecurityWatchlistToolServices } from '../agent_builder/tools/entity_analytics/watchlists/services';
import type { SecurityRuleCreationServices } from '../agent_builder/tools/rule_creation_services';
import type {
  SecurityEntityEnrichmentServices,
  SecurityEntityToolServices,
} from '../agent_builder/tools/entity_analytics/entity_services';
import type { EntityAnalyticsMlServices } from '../lib/entity_analytics/ml_anomaly_detection/ml_services';
import { watchlistConfigType } from '../lib/entity_analytics/watchlists/management/saved_object/watchlist_config_type';
import {
  watchlistEntitySourceType,
  WatchlistEntitySourceApiKeyEncryptionParams,
} from '../lib/entity_analytics/watchlists/entity_sources/infra/entity_source_type';
import type { EndpointWorkflowServices } from './endpoint_workflow_services';
import type { SecurityReadinessToolServices } from '../agent_builder/tools/siem_readiness/services';
import type { SecurityLeadToolServices } from '../agent_builder/tools/entity_analytics/leads/services';
import { leadGenerationConfigType } from '../lib/entity_analytics/lead_generation/saved_object';
import { registerAttachments } from '../agent_builder/attachments/register_attachments';
import type { SecurityAttachmentsServices } from '../agent_builder/attachments/services';
import { createNativeProductFeaturesReader } from '../lib/product_features_service';
import {
  SECURITY_AGENT_BUILDER_SETTINGS_ID,
  type SecurityAgentBuilderSettings,
} from './agent_builder_settings';

export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [
      SECURITY_AGENT_BUILDER_SETTINGS_ID,
      PRODUCT_DOC_READ_SETTINGS_ID,
      TASK_PROCESS_SETTINGS_ID,
      LISTS_TASK_PROCESS_SETTINGS_ID,
      RULE_REGISTRY_TASK_PROCESS_SETTINGS_ID,
    ],
    registerUiSettings: (registry, settings) => {
      const snapshot = settings[SECURITY_AGENT_BUILDER_SETTINGS_ID] as
        | SecurityAgentBuilderSettings
        | undefined;
      if (!snapshot) return;
      getSecurityRuleRunUiSettings(
        snapshot.config.experimentalFeatures,
        snapshot.config.enableUiSettingsValidations
      ).forEach((defaults) => registry.register(defaults));
    },
    savedObjectTypes: [
      ...productDocReadSavedObjectTypes,
      querySavedObjectType,
      exceptionListType,
      exceptionListAgnosticType,
      prebuiltRuleAssetType,
      watchlistConfigType,
      watchlistEntitySourceType,
      leadGenerationConfigType,
    ],
    createSavedObjectTypes: (encryption, settings) => {
      const snapshot = settings[SECURITY_AGENT_BUILDER_SETTINGS_ID] as
        | SecurityAgentBuilderSettings
        | undefined;
      if (!snapshot) return [];
      (encryption as Pick<EncryptedSavedObjectsPluginSetup, 'registerType'>).registerType(
        WatchlistEntitySourceApiKeyEncryptionParams
      );
      return snapshot.plugins.mitreAttack ? [mitreAttackEntityType] : [];
    },
  },
  register: async (agentBuilder, { host, services, settings, logger, kibanaVersion }) => {
    const snapshot = settings[SECURITY_AGENT_BUILDER_SETTINGS_ID] as
      | SecurityAgentBuilderSettings
      | undefined;
    if (!snapshot) return;
    const taskHost = host as TaskHost;
    const trackBackgroundTask = (task: Promise<void>): void => {
      services.registerRunCompletion(async () => {
        await task;
      });
    };
    let share: SharePluginStart | undefined;
    const getShare = (): SharePluginStart =>
      (share ??= {
        url: createServerUrlService({
          baseUrl: taskHost.server.publicBaseUrl || taskHost.http.basePath.serverBasePath,
          version: kibanaVersion,
          onBackgroundTask: trackBackgroundTask,
        }),
      });
    let mitreAttack: ReturnType<typeof createMitreAttackRunServices> | undefined;
    const getMitreAttack = () => {
      if (!snapshot.plugins.mitreAttack) return undefined;
      mitreAttack ??= createMitreAttackRunServices({
        savedObjects: taskHost.savedObjects,
        logger: logger.get('mitreAttack'),
        trackBackgroundTask,
      });
      return mitreAttack;
    };
    let llmTasks: ReturnType<typeof createLlmTasksRunServices> | undefined;
    const getLlmTasks = () => {
      if (!snapshot.plugins.llmTasks) return undefined;
      if (llmTasks) return llmTasks;
      const docSettings = settings[PRODUCT_DOC_READ_SETTINGS_ID] as
        | ProductDocReadSettings
        | undefined;
      if (!docSettings || !taskHost.taskManager)
        throw new Error(
          'Native Security documentation requires repository settings and Task Manager'
        );
      llmTasks = createLlmTasksRunServices({
        esClient: taskHost.elasticsearch.asInternalUser,
        createInternalRepository: (types) => taskHost.savedObjects.createInternalRepository(types),
        taskManager: taskHost.taskManager,
        settings: docSettings,
        kibanaVersion: taskHost.server.version,
        isServerless: taskHost.server.isServerless,
        inference: services.getInferenceStart() as InferenceServerStart,
        logger: logger.get('llmTasks'),
        documentationLogger: logger.get('productDocBase'),
      });
      return llmTasks;
    };
    const core: SecurityAttachmentsServices &
      SecurityWatchlistToolServices &
      SecurityRuleCreationServices &
      SecurityEntityEnrichmentServices &
      SecurityReadinessToolServices &
      SecuritySkillServices &
      SecurityLeadToolServices &
      RulePreviewServices = {
      trackBackgroundTask,
      getStartServices: async () => {
        if (!taskHost.uiSettings) throw new Error('Native Security tools require UI settings');
        return [
          {
            elasticsearch: { client: taskHost.elasticsearch },
            http: taskHost.http,
            uiSettings: taskHost.uiSettings,
            analytics: taskHost.analytics,
            savedObjects: taskHost.savedObjects,
            security: taskHost.security,
          },
          {
            get mitreAttack() {
              return getMitreAttack();
            },
            get encryptedSavedObjects() {
              return taskHost.encryptedSavedObjects;
            },
            get fleet() {
              if (!snapshot.plugins.fleet) return undefined;
              const fleet: NonNullable<
                Awaited<ReturnType<SecuritySkillServices['getStartServices']>>[1]['fleet']
              > = {
                packageService: {
                  asScoped: (request) => ({
                    getPackages: async (...args) => {
                      const runtime = await services
                        .getService<FleetWorkflowRunServices>('fleet.runServices')
                        .getServices();
                      return runtime.packageService.asScoped(request).getPackages(...args);
                    },
                  }),
                },
              };
              return fleet;
            },
            get actions() {
              return services.getService<Pick<ActionsPluginStart, 'getActionsClientWithRequest'>>(
                'actions'
              );
            },
            get share() {
              return getShare();
            },
            get data() {
              return { search: services.getService<StandaloneSearch>('data.search') };
            },
            get dataViews() {
              return services.getService<DataViewsServerPluginStart>('dataViews');
            },
            get inference() {
              return services.getInferenceStart() as InferenceServerStart;
            },
            get alerting() {
              return services.getService<WorkflowRulesReadServices>('alerting');
            },
            get spaces() {
              return services.getService<SpacesPluginStart>('spaces');
            },
            get llmTasks() {
              return getLlmTasks();
            },
            get security() {
              const security = taskHost.plugins?.security as SecurityTaskPluginStart | undefined;
              if (!security) throw new Error('Native Security entity tools require authorization');
              return { authz: security.authz };
            },
            get licensing() {
              const { licensing } = taskHost;
              if (!licensing) throw new Error('Native Security entity tools require licensing');
              return { getLicense: () => firstValueFrom(licensing.license$) };
            },
            get entityStore() {
              return services.getService<
                Awaited<
                  ReturnType<SecurityEntityToolServices['getStartServices']>
                >[1]['entityStore']
              >('entityStore');
            },
          },
        ];
      },
    };
    const productFeatures = createNativeProductFeaturesReader(snapshot.productFeatures);
    const getMlServices = () => services.getService<EntityAnalyticsMlServices>('ml.setup');
    const ml: EntityAnalyticsMlServices | undefined = snapshot.plugins.ml
      ? {
          jobServiceProvider: (...args) => getMlServices().jobServiceProvider(...args),
          resultsServiceProvider: (...args) => getMlServices().resultsServiceProvider(...args),
          modulesProvider: (...args) => getMlServices().modulesProvider(...args),
          mlSystemProvider: (...args) => getMlServices().mlSystemProvider(...args),
          anomalyDetectorsProvider: (...args) => getMlServices().anomalyDetectorsProvider(...args),
        }
      : undefined;
    let preview: ReturnType<typeof createSecurityPreviewRunServices> | undefined;
    const previewDeps: LazyRunRulePreviewDeps = {
      config: snapshot.config,
      ml,
      get security() {
        return snapshot.plugins.security ? { authc: taskHost.security.authc } : undefined;
      },
      getStartServices: core.getStartServices,
      logger,
      isServerless: snapshot.isServerless,
      getPreviewRunServices: () =>
        (preview ??= createSecurityPreviewRunServices({
          host: taskHost,
          settings,
          services,
          logger,
          kibanaVersion,
          snapshot,
        })),
    };
    registerTools(
      agentBuilder,
      core,
      logger,
      snapshot.config.experimentalFeatures,
      productFeatures,
      ml,
      previewDeps,
      snapshot.isServerless,
      kibanaVersion,
      snapshot.canEncrypt
    );
    await registerSkills({
      agentBuilder,
      experimentalFeatures: snapshot.config.experimentalFeatures,
      getStartServices: core.getStartServices,
      kibanaVersion,
      logger,
      ml,
      options: {
        endpointAppContextService: async () => {
          const endpoint = await services
            .getService<EndpointWorkflowServices>('securitySolution.endpoint')
            .getServices();
          return endpoint.endpointAppContextService;
        },
      },
    });
    await registerAttachments(agentBuilder, core, logger, snapshot.config.experimentalFeatures);
  },
};
