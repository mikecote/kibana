/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  ElasticsearchServiceStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import { SECURITY_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import { registerRoutes } from '@kbn/server-route-repository';
import type { KibanaRequest } from '@kbn/core/server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import type { AvailabilityConfig } from '@kbn/agent-builder-server';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';
import { NIGHTSHIFT_ONBOARDING_SUGGESTIONS_WORKFLOW_ID } from '@kbn/workflows/managed';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import type { InvestigationAttachmentDocService } from '@kbn/agentic-investigations-plugin/server';
import type { NightshiftInvestigationsConfig } from './config';
import { InvestigationLocatorDefinition } from '../common/locators';
import { NightshiftInvestigationsClient } from './client/investigations_client';
import { createIsNightshiftEnabled } from './is_nightshift_enabled';
import { NIGHTSHIFT_INVESTIGATIONS_MANAGED_WORKFLOW_OWNER } from './lib/managed_workflows/constants';
import { installInvestigationWorkflow } from './lib/managed_workflows/install_investigation_workflow';
import { installDecisionTreeWorkflows } from './lib/managed_workflows/install_decision_tree_workflows';
import { installSandboxMaterializeWorkspaceWorkflow } from './lib/managed_workflows/install_sandbox_materialize_workspace';
import { installAgentOptimizationsWorkflow } from './lib/managed_workflows/install_agent_optimizations';
import { installInvestigationAgent } from './lib/install_investigation_agent';
import { createInvestigationAvailability } from './create_investigation_availability';
import { nightshiftInvestigationsRouteRepository } from './routes';
import {
  isInvestigationInfrastructureAvailable,
  isInvestigationRunAvailable,
} from './is_investigation_available';
import { notificationRoutingAttachment } from './lib/notifications/notification_routing';
import type { StoredNotificationRouting } from './lib/notifications/notification_routing';
import { NotificationRoutingClient } from './lib/notifications/notification_routing_client';
import { createCortexStore, registerCortexAiIndex } from './cortex/register_cortex';
import { registerMemoryAiIndex } from './memory/register_memory';
import { registerCortexTelemetryEvents } from './telemetry';
import { createMemoryPageStore } from './memory/page_store';
import { createDecisionTreeStore } from './decision_trees/store';
import { registerDecisionTreeAiIndex } from './decision_trees/register_decision_trees';
import { setupNightshiftTelemetry } from './telemetry';
import { createTriggerEmitter, type TriggerEmitter } from './workflows/triggers/emit';
import {
  NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID,
  getNightshiftTaskProcessSettings,
} from './task_types/nightshift_task_process_settings';
import { registerNightshiftWorkflowSteps } from './workflows/register_workflow_steps';
import { registerInvestigationsWorkflowTriggers } from './workflows/triggers/register_triggers';
import { registerNightshiftAgentBuilder } from './register_agent_builder';
import {
  nightshiftSecretsEncryptionParams,
  nightshiftSecretsSavedObjectType,
  nightshiftCustomContextSavedObjectType,
  nightshiftAutomationSavedObjectType,
  nightshiftAutomationBudgetSavedObjectType,
  NIGHTSHIFT_AUTOMATION_BUDGET_SO_TYPE,
  NIGHTSHIFT_AUTOMATION_SO_TYPE,
} from './saved_objects';
import { createOnboardingClient } from './onboarding/onboarding_client';
import { createSandboxSecretsClient } from './sandbox_secrets';
import { createCustomContextClient } from './custom_context';
import type {
  InvestigationQuotaCallback,
  NightshiftInvestigationsServerSetup,
  NightshiftInvestigationsServerStart,
  NightshiftInvestigationsSetupDeps,
  NightshiftInvestigationsStartDeps,
} from './types';

export class NightshiftInvestigationsPlugin
  implements
    Plugin<
      NightshiftInvestigationsServerSetup,
      NightshiftInvestigationsServerStart,
      NightshiftInvestigationsSetupDeps,
      NightshiftInvestigationsStartDeps
    >
{
  private readonly logger: Logger;
  private workflowsManagement?: NightshiftInvestigationsSetupDeps['workflowsManagement'];
  private workflowsExtensionsStart?: NightshiftInvestigationsStartDeps['workflowsExtensions'];
  private spaces?: NightshiftInvestigationsStartDeps['spaces'];
  private agentBuilder?: NightshiftInvestigationsStartDeps['agentBuilder'];
  private agenticInvestigations?: NightshiftInvestigationsStartDeps['agenticInvestigations'];
  private proposals?: NightshiftInvestigationsStartDeps['proposals'];
  private inference?: NightshiftInvestigationsStartDeps['inference'];
  private sandboxStart?: NightshiftInvestigationsStartDeps['sandbox'];
  private ruleRegistry?: NightshiftInvestigationsStartDeps['ruleRegistry'];
  private elasticsearch?: ElasticsearchServiceStart;
  private savedObjects?: CoreStart['savedObjects'];
  private uiSettings?: CoreStart['uiSettings'];
  private featureFlags?: CoreStart['featureFlags'];
  private actionsStart?: ActionsPluginStart;
  private encryptedSavedObjectsStart?: NightshiftInvestigationsStartDeps['encryptedSavedObjects'];
  private securityStart?: NightshiftInvestigationsStartDeps['security'];
  private security?: CoreStart['security'];
  private notificationRoutingService?: InvestigationAttachmentDocService<StoredNotificationRouting>;
  private investigationAvailability?: AvailabilityConfig;
  private cortexEnabled = false;
  private memoryEnabled = false;
  private investigationQuotaCallback?: InvestigationQuotaCallback;
  private decisionTreesEnabled = false;

  constructor(private readonly ctx: PluginInitializerContext<NightshiftInvestigationsConfig>) {
    this.logger = ctx.logger.get();
  }

  setup(
    core: CoreSetup<NightshiftInvestigationsStartDeps, NightshiftInvestigationsServerStart>,
    plugins: NightshiftInvestigationsSetupDeps
  ): NightshiftInvestigationsServerSetup {
    this.workflowsManagement = plugins.workflowsManagement;
    const investigationLocator = plugins.share.url.locators.create(
      new InvestigationLocatorDefinition()
    );
    registerInvestigationsWorkflowTriggers(plugins.workflowsExtensions);
    const isNightshiftEnabled = createIsNightshiftEnabled(core.getStartServices);
    plugins.alerting?.enableAlertStatusChanged({ isEnabled: isNightshiftEnabled });
    const telemetry = setupNightshiftTelemetry({
      analytics: core.analytics,
      logger: this.logger.get('telemetry'),
    });

    this.cortexEnabled = this.ctx.config.get().cortex.enabled;
    this.memoryEnabled = this.ctx.config.get().memory.enabled;
    if (this.cortexEnabled) {
      registerCortexAiIndex(plugins.contextEngine, this.logger.get('cortex'));
      registerCortexTelemetryEvents(core.analytics);
    }
    if (this.memoryEnabled) {
      registerMemoryAiIndex(plugins.contextEngine, this.logger.get('memory'));
    }

    this.decisionTreesEnabled =
      this.ctx.config.get().decision_trees.enabled &&
      this.cortexEnabled &&
      Boolean(plugins.sandbox?.isAvailable);
    // What the steps and triggers read of this plugin in a task process of the workflow task types.
    plugins.workflowsExtensions?.registerTaskProcessSettings(
      NIGHTSHIFT_TASK_PROCESS_SETTINGS_ID,
      () =>
        getNightshiftTaskProcessSettings({
          workflowsManagementAvailable: Boolean(plugins.workflowsManagement),
          decisionTreesEnabled: this.decisionTreesEnabled,
          telemetryConnectorId: this.ctx.config.get().sandbox?.telemetry_connector_id,
          telemetryReadableIndices: this.ctx.config.get().sandbox?.telemetry_readable_indices,
          cortexEnabled: this.cortexEnabled,
          memoryEnabled: this.memoryEnabled,
          hasInvestigationQuotaCallback: Boolean(this.investigationQuotaCallback),
          agentBuilderAvailable: Boolean(plugins.agentBuilder),
          agenticInvestigationsAvailable: Boolean(plugins.agenticInvestigations),
          proposalsAvailable: Boolean(plugins.proposals),
          spacesEnabled: Boolean(this.spaces),
          sandboxAvailable: Boolean(plugins.sandbox?.isAvailable),
          canEncrypt: plugins.encryptedSavedObjects?.canEncrypt === true,
          securityAvailable: Boolean(this.securityStart),
          actionsAvailable: Boolean(this.actionsStart),
          inferenceAvailable: Boolean(this.inference),
        })
    );

    if (this.decisionTreesEnabled) {
      registerDecisionTreeAiIndex(plugins.contextEngine, this.logger.get('decision_trees'));
    }

    core.savedObjects.registerType(nightshiftAutomationSavedObjectType);
    core.savedObjects.registerType(nightshiftAutomationBudgetSavedObjectType);
    core.savedObjects.registerType(nightshiftSecretsSavedObjectType);
    core.savedObjects.registerType(nightshiftCustomContextSavedObjectType);
    plugins.encryptedSavedObjects?.registerType(nightshiftSecretsEncryptionParams);

    const customContextClient = createCustomContextClient({
      getDeps: () => ({
        featureFlags: this.featureFlags,
        savedObjects: this.savedObjects,
        security: this.security,
        securityPlugin: this.securityStart,
        spaces: this.spaces,
      }),
    });

    const sandboxSecretsClient = createSandboxSecretsClient({
      getDeps: () => ({
        featureFlags: this.featureFlags,
        savedObjects: this.savedObjects,
        encryptedSavedObjects: this.encryptedSavedObjectsStart,
        security: this.securityStart,
        spaces: this.spaces,
      }),
      canEncrypt: plugins.encryptedSavedObjects?.canEncrypt ?? false,
      logger: this.logger.get('sandbox_secrets'),
    });

    const onboardingClient = createOnboardingClient({
      getDeps: () => ({
        workflowsManagement: this.workflowsManagement,
        spaces: this.spaces,
      }),
      listSandboxSecretKeys: (request) => sandboxSecretsClient.listKeysForSandbox(request),
      logger: this.logger.get('onboarding'),
    });

    const getTriggerEmitter = (request: KibanaRequest): TriggerEmitter | undefined =>
      createTriggerEmitter({
        workflowsExtensions: this.workflowsExtensionsStart,
        request,
        logger: this.logger,
      });

    plugins.workflowsExtensions?.registerManagedWorkflowOwner(
      NIGHTSHIFT_INVESTIGATIONS_MANAGED_WORKFLOW_OWNER
    );

    if (plugins.agentBuilder) {
      registerNightshiftAgentBuilder({
        agentBuilder: plugins.agentBuilder,
        settings: getNightshiftTaskProcessSettings({
          workflowsManagementAvailable: Boolean(plugins.workflowsManagement),
          decisionTreesEnabled: this.decisionTreesEnabled,
          cortexEnabled: this.cortexEnabled,
          memoryEnabled: this.memoryEnabled,
          sandboxAvailable: Boolean(plugins.sandbox?.isAvailable),
          agenticInvestigationsAvailable: Boolean(plugins.agenticInvestigations),
          proposalsAvailable: Boolean(plugins.proposals),
          telemetryConnectorId: this.ctx.config.get().sandbox?.telemetry_connector_id,
          telemetryReadableIndices: this.ctx.config.get().sandbox?.telemetry_readable_indices,
        }),
        logger: this.logger,
        getAgentBuilder: () => this.agentBuilder,
        getRoutingService: () => this.getNotificationRoutingService(),
        customContextClient,
        sandboxSecretsClient,
        getSandboxStart: () => this.sandboxStart,
        getActions: () => this.actionsStart,
        getFeatureFlags: () => this.featureFlags,
        getSecurity: () => this.securityStart,
        getSpaceId: (request) => this.spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID,
        getCoreSecurity: () => this.security,
      });
    }

    if (plugins.workflowsManagement) {
      if (plugins.workflowsExtensions) {
        registerNightshiftWorkflowSteps(plugins.workflowsExtensions, {
          getInference: () => this.inference,
          getSavedObjects: () => this.savedObjects,
          getUiSettings: () => this.uiSettings,
          getTelemetryConnectorId: () => this.ctx.config.get().sandbox?.telemetry_connector_id,
          isDecisionTreesEnabled: () => this.decisionTreesEnabled,
          isCortexEnabled: () => this.cortexEnabled,
          isMemoryEnabled: () => this.memoryEnabled,
          logger: this.logger,
          getInvestigationsClient: this.getInvestigationsClient,
          getAutomationsSoClient: this.getAutomationsSoClient,
          getAgentBuilder: () => this.agentBuilder,
          getAgentAvailability: () => this.getInvestigationAvailability(),
          investigationLocator,
          getActions: () => this.actionsStart,
          getRoutingClient: this.getNotificationRoutingClient,
          getTriggerEmitter,
          getSandboxStart: () => this.sandboxStart,
          analytics: core.analytics,
          telemetry,
        });
      }

      registerRoutes({
        repository: nightshiftInvestigationsRouteRepository,
        dependencies: {
          getInvestigationsClient: this.getInvestigationsClient,
          getTriggerEmitter,
          getAlertsClient: (request: KibanaRequest) =>
            this.ruleRegistry?.getRacClientWithRequest(request),
          getAutomationsSoClient: this.getAutomationsSoClient,
          getWorkflowsManagement: () => this.workflowsManagement,
          isCortexEnabled: () => this.cortexEnabled,
          sandboxSecretsClient,
          customContextClient,
          onboardingClient,
          getCortexPageStore: (request: KibanaRequest) => {
            if (!this.elasticsearch) {
              throw new Error(
                'elasticsearch is not available — plugin start() has not been called'
              );
            }
            return createCortexStore({
              esClient: this.elasticsearch.client.asScoped(request).asCurrentUser,
              logger: this.logger.get('cortex'),
              spaceId: this.spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID,
            });
          },
          isDecisionTreesEnabled: () => this.decisionTreesEnabled,
          getDecisionTreeStore: (request: KibanaRequest) => {
            if (!this.elasticsearch) {
              throw new Error(
                'elasticsearch is not available — plugin start() has not been called'
              );
            }
            return createDecisionTreeStore({
              esClient: this.elasticsearch.client.asScoped(request).asCurrentUser,
              logger: this.logger.get('decision_trees'),
              spaceId: this.spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID,
            });
          },
          isMemoryEnabled: () => this.memoryEnabled,
          getMemoryPageStore: (request: KibanaRequest) => {
            if (!this.elasticsearch) {
              throw new Error(
                'elasticsearch is not available — plugin start() has not been called'
              );
            }
            return createMemoryPageStore({
              esClient: this.elasticsearch.client.asScoped(request).asCurrentUser,
              logger: this.logger.get('memory'),
              spaceId: this.spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID,
            });
          },
        },
        core,
        logger: this.logger,
        runDevModeChecks: false,
      });
    } else {
      this.logger.warn(
        'workflowsManagement is not available — nightshift investigations routes will not be registered'
      );
    }

    return {
      registerInvestigationQuota: (callback) => {
        if (this.investigationQuotaCallback) {
          throw new Error('Investigation quota callback is already registered');
        }
        this.investigationQuotaCallback = callback;
      },
    };
  }

  start(
    coreStart: CoreStart,
    plugins: NightshiftInvestigationsStartDeps
  ): NightshiftInvestigationsServerStart {
    this.spaces = plugins.spaces;
    this.workflowsExtensionsStart = plugins.workflowsExtensions;
    this.agentBuilder = plugins.agentBuilder;
    this.agenticInvestigations = plugins.agenticInvestigations;
    this.proposals = plugins.proposals;
    this.inference = plugins.inference;
    this.sandboxStart = plugins.sandbox;
    this.ruleRegistry = plugins.ruleRegistry;
    this.elasticsearch = coreStart.elasticsearch;
    this.savedObjects = coreStart.savedObjects;
    this.uiSettings = coreStart.uiSettings;
    this.featureFlags = coreStart.featureFlags;
    this.actionsStart = plugins.actions;
    this.encryptedSavedObjectsStart = plugins.encryptedSavedObjects;
    this.securityStart = plugins.security;
    this.security = coreStart.security;
    this.notificationRoutingService = notificationRoutingAttachment.createService({
      esClient: coreStart.elasticsearch.client.asInternalUser,
      logger: this.logger,
    });

    // Installed here so the agent is visible in the Agent Builder UI before the first run.
    if (plugins.agentBuilder) {
      const { agentBuilder } = plugins;
      void installInvestigationAgent({
        agentBuilder,
        spaceId: DEFAULT_SPACE_ID,
        availability: this.getInvestigationAvailability(),
      }).catch((err) => {
        this.logger.error(`Failed to install investigation agent in default space: ${err.message}`);
      });
    }

    if (plugins.workflowsExtensions) {
      this.installManagedWorkflows(plugins.workflowsExtensions).catch((err) => {
        this.logger.error(
          `Failed to install nightshift investigations managed workflows: ${err.message}`
        );
      });
    }

    return {
      getInvestigationsClient: this.getInvestigationsClient,
      isInvestigationAvailable: (request) =>
        isInvestigationRunAvailable({
          request,
          featureFlags: coreStart.featureFlags,
          agentBuilder: this.agentBuilder,
          inference: this.inference,
          agenticInvestigations: this.agenticInvestigations,
          proposals: this.proposals,
          logger: this.logger,
          spaces: this.spaces,
          workflowsExtensions: this.workflowsExtensionsStart,
          workflowsManagement: this.workflowsManagement,
        }),
    };
  }

  /** Created once so every `agents.ensure` call registers the same gate; deps read lazily. */
  private getInvestigationAvailability = (): AvailabilityConfig => {
    this.investigationAvailability ??= createInvestigationAvailability({
      getDeps: () => {
        if (!this.featureFlags) {
          return undefined;
        }
        return {
          featureFlags: this.featureFlags,
          agentBuilder: this.agentBuilder,
          inference: this.inference,
          agenticInvestigations: this.agenticInvestigations,
          proposals: this.proposals,
          logger: this.logger,
          spaces: this.spaces,
          workflowsExtensions: this.workflowsExtensionsStart,
          workflowsManagement: this.workflowsManagement,
        };
      },
    });
    return this.investigationAvailability;
  };

  private getInvestigationsClient = (request: KibanaRequest, spaceId?: string) => {
    if (!this.featureFlags) {
      throw new Error('featureFlags is not available — plugin start() has not been called');
    }
    const resolvedSpaceId =
      spaceId ?? this.spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID;

    return new NightshiftInvestigationsClient({
      request,
      workflowsManagement: this.workflowsManagement,
      spaces: this.spaces,
      logger: this.logger,
      spaceIdOverride: spaceId,
      agentBuilder: this.agentBuilder,
      agenticInvestigations: this.agenticInvestigations,
      agentAvailability: this.getInvestigationAvailability(),
      investigationQuotaCallback: this.investigationQuotaCallback,
      inference: this.inference,
      savedObjects: this.savedObjects,
      uiSettings: this.uiSettings,
      isAvailable: (connectorId) =>
        isInvestigationRunAvailable({
          request,
          featureFlags: this.featureFlags!,
          agentBuilder: this.agentBuilder,
          inference: this.inference,
          agenticInvestigations: this.agenticInvestigations,
          proposals: this.proposals,
          logger: this.logger,
          connectorId,
          spaceId: resolvedSpaceId,
          spaces: this.spaces,
          workflowsExtensions: this.workflowsExtensionsStart,
          workflowsManagement: this.workflowsManagement,
        }),
      isInfrastructureAvailable: () =>
        isInvestigationInfrastructureAvailable({
          request,
          featureFlags: this.featureFlags!,
          agentBuilder: this.agentBuilder,
          inference: this.inference,
          agenticInvestigations: this.agenticInvestigations,
          proposals: this.proposals,
          logger: this.logger,
          spaceId: resolvedSpaceId,
          spaces: this.spaces,
          workflowsExtensions: this.workflowsExtensionsStart,
          workflowsManagement: this.workflowsManagement,
        }),
    });
  };

  private getNotificationRoutingService =
    (): InvestigationAttachmentDocService<StoredNotificationRouting> => {
      if (!this.notificationRoutingService) {
        throw new Error('Notification routing storage is not available');
      }
      return this.notificationRoutingService;
    };

  private getNotificationRoutingClient = async (
    request: KibanaRequest,
    spaceId: string,
    conversationId: string,
    investigationId: string
  ): Promise<NotificationRoutingClient> => {
    if (!this.agentBuilder) {
      throw new Error('agentBuilder is not available');
    }
    if (request.spaceId !== spaceId) {
      throw new Error('Notification request and execution spaces do not match');
    }
    const [attachments, conversations] = await Promise.all([
      this.agentBuilder.attachments.getScopedClient({ request }),
      this.agentBuilder.conversations.getScopedClient({ request }),
    ]);
    return new NotificationRoutingClient({
      service: this.getNotificationRoutingService(),
      attachments,
      conversations,
      spaceId,
      conversationId,
      investigationId,
    });
  };

  private getAutomationsSoClient = (request: KibanaRequest, spaceId: string) => {
    if (!this.savedObjects) {
      throw new Error('savedObjects is not available — plugin start() has not been called');
    }
    return this.savedObjects
      .getScopedClient(request, {
        excludedExtensions: [SECURITY_EXTENSION_ID],
        includedHiddenTypes: [NIGHTSHIFT_AUTOMATION_SO_TYPE, NIGHTSHIFT_AUTOMATION_BUDGET_SO_TYPE],
      })
      .asScopedToNamespace(spaceId);
  };

  /**
   * Installs the static managed workflows this plugin owns and signals readiness so the
   * platform can reconcile (prune orphans / apply upgrades) for this plugin's workflows.
   */
  private async installManagedWorkflows(
    workflowsExtensions: WorkflowsExtensionsServerPluginStart
  ): Promise<void> {
    const client = await workflowsExtensions.initManagedWorkflowsClient(
      NIGHTSHIFT_INVESTIGATIONS_MANAGED_WORKFLOW_OWNER
    );
    await installInvestigationWorkflow({ client });
    await client.install(NIGHTSHIFT_ONBOARDING_SUGGESTIONS_WORKFLOW_ID, {
      spaceId: GLOBAL_WORKFLOW_SPACE_ID,
    });
    if (this.cortexEnabled || this.memoryEnabled) {
      await installSandboxMaterializeWorkspaceWorkflow({ client });
      await installAgentOptimizationsWorkflow({ client });
    }
    if (this.decisionTreesEnabled) {
      await installDecisionTreeWorkflows({ client });
    }
    await client.ready();
  }

  stop(): void {}
}
