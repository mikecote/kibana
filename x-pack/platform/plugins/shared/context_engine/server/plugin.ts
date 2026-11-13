/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  ElasticsearchClient,
  KibanaRequest,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/logging';
import { CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { WorkflowsManagementOperationPrivileges } from '@kbn/workflows';
import { CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID } from '../common/constants';
import type {
  ContextEnginePluginSetup,
  ContextEnginePluginStart,
  ContextEngineSetupDependencies,
  ContextEngineStartDependencies,
  DeleteWorkflowsApi,
  GetAiIndexDataReadServiceParams,
} from './types';
import type { KiVerifierWorkflowRunner } from './ki_verification';
import { registerFeatures } from './features';
import { registerAiIndexRoutes } from './routes/ai_indices';
import { registerSignalRoutes } from './routes/signals';
import type {
  FeedbackAnalysisScheduleService,
  WorkflowEnablementApi,
} from './feedback_analysis/schedule';
import { createFeedbackAnalysisScheduleService } from './feedback_analysis/schedule';
import type { AiIndexDataReadServiceApi } from './ai_indices/data_read_service';
import type { ImprovementsServiceApi } from './improvements/service';
import type { AiIndexService } from './ai_indices/service';
import { AiIndexRegistry } from './ai_indices/registry';
import { CONTEXT_ENGINE_MANAGED_INDICES_SETTINGS_ID } from './task_types/task_process_settings';
import { installImprovementsIndexTemplate } from './improvements/storage';
import { contextEngineGlobalUiSettings } from './ui_settings';
import { createContextEngineRunServices } from './run_services/create_context_engine_run_services';
import type { SignalsServiceApi } from './signals/service';
import { registerSignalGeneratorTaskDefinition, scheduleSignalGenerator } from './tasks';
import { createVerifyKi } from './step_types/verify_ki';
import { registerStepDefinitions } from './step_types';
import { ContextEngineAnalyticsService } from './telemetry';
import { isContextEngineEnabledInSpace } from './utils/is_context_engine_enabled_in_space';
import { createPrivilegeChecks } from './utils/create_privilege_checks';
import { resolveSpaceId } from './utils/resolve_space_id';

/** Must match the `pluginId` on the managed workflow definition. */
const CONTEXT_ENGINE_WORKFLOW_OWNER = 'contextEngine';

export class ContextEnginePlugin
  implements
    Plugin<
      ContextEnginePluginSetup,
      ContextEnginePluginStart,
      ContextEngineSetupDependencies,
      ContextEngineStartDependencies
    >
{
  private logger: Logger;
  private aiIndexService?: AiIndexService;
  private signalsService?: SignalsServiceApi;
  private createImprovementsService?: (
    esClient: ElasticsearchClient,
    spaceId: string
  ) => ImprovementsServiceApi;
  private createAiIndexDataReadService?: (
    params: GetAiIndexDataReadServiceParams
  ) => AiIndexDataReadServiceApi;
  private esClient?: ElasticsearchClient;
  private scheduleService?: FeedbackAnalysisScheduleService;
  /** Captured at setup because the schedule service, built at start, enables workflows with it. */
  private workflowsManagement?: WorkflowEnablementApi;
  private isFeedbackLoopEnabled: () => Promise<boolean> = async () => false;
  private readonly aiIndexRegistry = new AiIndexRegistry();
  private analyticsService?: ContextEngineAnalyticsService;
  private workflowsManagementApiPromise: Promise<
    (DeleteWorkflowsApi & KiVerifierWorkflowRunner) | undefined
  > = Promise.resolve(undefined);

  constructor(context: PluginInitializerContext) {
    this.logger = context.logger.get();
  }

  setup(
    coreSetup: CoreSetup<ContextEngineStartDependencies, ContextEnginePluginStart>,
    setupDeps: ContextEngineSetupDependencies
  ): ContextEnginePluginSetup {
    registerFeatures({ features: setupDeps.features });
    this.setupWorkflowsManagement(coreSetup);

    this.workflowsManagement = setupDeps.workflowsManagement?.management;

    this.analyticsService = new ContextEngineAnalyticsService(
      coreSetup.analytics,
      this.logger.get('telemetry')
    );
    this.analyticsService.registerContextEngineEventTypes();
    const analyticsService = this.analyticsService;

    const { checkApiPrivileges, checkWritePrivilege } = createPrivilegeChecks({
      getAuthz: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.security?.authz;
      },
    });

    const verifyKi = createVerifyKi({
      getAuditLogger: async (request) => {
        const [coreStart] = await coreSetup.getStartServices();
        return coreStart.security.audit.asScoped(request);
      },
      workflowVerifierDeps: {
        getWorkflowsManagement: () => this.workflowsManagementApiPromise,
        checkExecutePrivilege: (request, spaceId) =>
          checkApiPrivileges(request, spaceId, WorkflowsManagementOperationPrivileges.execute),
      },
      analyticsService,
      logger: this.logger.get('context_steps'),
    });

    coreSetup.uiSettings.registerGlobal(contextEngineGlobalUiSettings);
    setupDeps.workflowsExtensions.registerTaskProcessSettings(
      CONTEXT_ENGINE_MANAGED_INDICES_SETTINGS_ID,
      () => ({ registrations: this.aiIndexRegistry.getRegistrations() })
    );

    registerSignalGeneratorTaskDefinition({
      taskManager: setupDeps.taskManager,
      getEsClient: () => {
        if (!this.esClient) {
          throw new Error('Elasticsearch client not available — plugin has not started');
        }
        return this.esClient;
      },
      getSignalsService: (): SignalsServiceApi => {
        if (!this.signalsService) {
          throw new Error('Signals service not available — plugin has not started');
        }
        return this.signalsService;
      },
      getFeedbackLoopEnabled: () => this.isFeedbackLoopEnabled(),
      logger: this.logger.get('signal_generator'),
    });

    setupDeps.workflowsExtensions.registerManagedWorkflowOwner(CONTEXT_ENGINE_WORKFLOW_OWNER);

    const getAiIndexService = () => {
      if (!this.aiIndexService) {
        throw new Error('AI index service not available — plugin has not started');
      }
      return this.aiIndexService;
    };

    const getImprovementsService = (esClient: ElasticsearchClient, spaceId: string) => {
      if (!this.createImprovementsService) {
        throw new Error('Improvements service not available — plugin has not started');
      }
      return this.createImprovementsService(esClient, spaceId);
    };

    const getScheduleService = () => {
      if (!this.scheduleService) {
        throw new Error('Schedule service not available — plugin has not started');
      }
      return this.scheduleService;
    };

    const isMemoryEnabled = async (request: KibanaRequest) => {
      const [coreStart] = await coreSetup.getStartServices();
      const savedObjectsClient = coreStart.savedObjects.getScopedClient(request);
      const globalUiSettings = coreStart.uiSettings.globalAsScopedToClient(savedObjectsClient);
      return (
        (await globalUiSettings.get<boolean>(CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID)) ?? false
      );
    };

    const router = coreSetup.http.createRouter();
    registerAiIndexRoutes({
      router,
      logger: this.logger.get('routes'),
      getAiIndexService,
      getImprovementsService,
      getScheduleService,
      isMemoryEnabled,
      getAiIndexDataReadService: (params) => {
        if (!this.createAiIndexDataReadService) {
          throw new Error('AI index read service not available — plugin has not started');
        }
        return this.createAiIndexDataReadService(params);
      },
      getActions: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.actions;
      },
      // Resolved at runtime because a static dependency on agentBuilder would be a cycle:
      // agentBuilder -> agentBuilderSml -> contextEngine.
      getAgentBuilder: async () => {
        const { agentBuilder } = await coreSetup.plugins.onStart<{
          agentBuilder: AgentBuilderPluginStart;
        }>('agentBuilder');
        return agentBuilder.found ? agentBuilder.contract : undefined;
      },
      getWorkflowsManagementApi: () => this.workflowsManagementApiPromise,
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
    });

    const isContextEngineEnabled = async (spaceId: string) => {
      const [coreStart] = await coreSetup.getStartServices();
      return isContextEngineEnabledInSpace({
        savedObjects: coreStart.savedObjects,
        uiSettings: coreStart.uiSettings,
        spaceId,
      });
    };

    registerStepDefinitions({
      workflowsExtensions: setupDeps.workflowsExtensions,
      analyticsService,
      logger: this.logger.get('context_steps'),
      getAiIndexService,
      isContextEngineEnabled,
      checkWritePrivilege,
      verifyKi,
      feedbackAnalysis: {
        getAiIndexService,
        getImprovementsService,
        getAuditLogger: async (request) => {
          const [coreStart] = await coreSetup.getStartServices();
          return coreStart.security.audit.asScoped(request);
        },
        isContextEngineEnabled,
        isFeedbackLoopEnabled: () => this.isFeedbackLoopEnabled(),
        checkWritePrivilege,
        logger: this.logger.get('feedback_analysis'),
      },
    });

    // Read-only Signals routes (reads run as the current user, scoped to the active space).
    registerSignalRoutes({
      router,
      getSpaces: async () => {
        const [, startDeps] = await coreSetup.getStartServices();
        return startDeps.spaces;
      },
      // Reads the current value at request time (assigned in start(), after this setup() runs).
      getFeedbackLoopEnabled: () => this.isFeedbackLoopEnabled(),
    });

    return {
      registerAiIndex: (id, properties) => this.aiIndexRegistry.register(id, properties),
    };
  }

  private setupWorkflowsManagement(
    coreSetup: CoreSetup<ContextEngineStartDependencies, ContextEnginePluginStart>
  ): void {
    try {
      this.workflowsManagementApiPromise = coreSetup.plugins
        .onSetup<{
          workflowsManagement: { management: DeleteWorkflowsApi & KiVerifierWorkflowRunner };
        }>('workflowsManagement')
        .then(({ workflowsManagement }) =>
          workflowsManagement.found ? workflowsManagement.contract.management : undefined
        )
        .catch(() => undefined);
    } catch {
      this.workflowsManagementApiPromise = Promise.resolve(undefined);
    }
  }

  start(coreStart: CoreStart, startDeps: ContextEngineStartDependencies): ContextEnginePluginStart {
    this.aiIndexRegistry.freeze();

    this.esClient = coreStart.elasticsearch.client.asInternalUser;

    const runServices = createContextEngineRunServices({
      esClient: this.esClient,
      logger: this.logger,
      savedObjects: coreStart.savedObjects,
      uiSettings: coreStart.uiSettings,
      audit: coreStart.security.audit,
      getSpaceId: (request) => resolveSpaceId(startDeps.spaces, request),
      managedAiIndices: this.aiIndexRegistry,
    });
    this.aiIndexService = runServices.aiIndexService;
    this.signalsService = runServices.getSignalsService();
    this.createImprovementsService = runServices.getImprovementsService;
    this.createAiIndexDataReadService = runServices.getAiIndexDataReadService;

    const improvementsLogger = this.logger.get('improvements');

    // Installed as Kibana, with the cluster privilege it already holds. The index is left for the
    // first user write to create from it, so the store needs no grant on the internal user.
    installImprovementsIndexTemplate({
      esClient: this.esClient,
      logger: improvementsLogger,
    }).catch((err) => {
      improvementsLogger.warn(
        `Failed to install the improvements index template: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });

    this.scheduleService = createFeedbackAnalysisScheduleService({
      logger: this.logger,
      getManagedWorkflowsClient: () =>
        startDeps.workflowsExtensions.initManagedWorkflowsClient(CONTEXT_ENGINE_WORKFLOW_OWNER),
      ...(this.workflowsManagement ? { workflowsManagement: this.workflowsManagement } : {}),
    });

    const soClient = coreStart.savedObjects.createInternalRepository();
    const globalUiSettings = coreStart.uiSettings.globalAsScopedToClient(soClient);

    this.isFeedbackLoopEnabled = async () =>
      (await globalUiSettings.get<boolean>(CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID)) ??
      false;

    scheduleSignalGenerator({ taskManager: startDeps.taskManager }).catch((err) => {
      this.logger.warn(
        `Failed to schedule signal generator: ${err instanceof Error ? err.message : String(err)}`
      );
    });

    return {
      getAiIndexService: () => {
        if (!this.aiIndexService) {
          throw new Error('AI index service not available — plugin has not started');
        }
        return this.aiIndexService;
      },
      getAiIndexDataReadService: runServices.getAiIndexDataReadService,
      getSignalsService: runServices.getSignalsService,
      getImprovementsService: runServices.getImprovementsService,
    };
  }

  stop() {}
}
