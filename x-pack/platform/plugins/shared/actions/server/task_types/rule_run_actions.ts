/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Observable } from 'rxjs';
import type {
  AnalyticsServiceStart,
  KibanaRequest,
  Logger,
  SavedObjectsServiceStart,
  SecurityServiceStart,
  IClusterClient,
} from '@kbn/core/server';
import type { IEventLogger } from '@kbn/event-log-plugin/server';
import { createStandaloneEventLogClientService } from '@kbn/event-log-plugin/server/standalone_event_log_client';
import type { SpacesServiceStart } from '@kbn/spaces-plugin/server';
import { SECURITY_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import type { ILicense } from '@kbn/licensing-types';
import type { UsageCounter } from '@kbn/usage-collection-plugin/server';
import type { IUsageCounter } from '@kbn/usage-collection-plugin/server/usage_counters/usage_counter';
import type { LicensingPluginSetup } from '@kbn/licensing-plugin/server';
import type { EncryptedSavedObjectsClient } from '@kbn/encrypted-saved-objects-plugin/server';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { SystemIdentity } from '@kbn/security-plugin-types-server';
import type { PluginSetupContract, PluginStartContract } from '../plugin';
import { renderActionParameterTemplates } from '../lib/render_action_parameter_templates';
import { ActionTypeRegistry } from '../action_type_registry';
import { ActionsAuthorization } from '../authorization/actions_authorization';
import { ActionsClient } from '../actions_client/actions_client';
import { AuthTypeRegistry, registerAuthTypes } from '../auth_types';
import { getActionsConfigurationUtilities } from '../actions_config';
import type { ActionsConfig } from '../config';
import {
  ACTION_SAVED_OBJECT_TYPE,
  ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
  ALERT_SAVED_OBJECT_TYPE,
} from '../constants/saved_objects';
import { createBulkExecutionEnqueuerFunction } from '../create_execute_function';
import { createBulkUnsecuredExecutionEnqueuerFunction } from '../create_unsecured_execute_function';
import { UnsecuredActionsClient } from '../unsecured_actions_client/unsecured_actions_client';
import type { InMemoryConnector } from '../types';
import { createSystemConnectors } from '../create_system_actions';
import { ensureSufficientLicense } from '../lib/ensure_sufficient_license';
import { getInMemoryConnectorsFromConfig } from '../lib/get_in_memory_connectors_from_config';
import { ActionExecutor } from '../lib/action_executor';
import { ConnectorRateLimiter } from '../lib/connector_rate_limiter';
import { ConnectorTokenClient } from '../lib/connector_token_client';
import { LeasePool } from '../lib/lease_pool';
import { LicenseState } from '../lib/license_state';
import {
  getCurrentUserProfileIdFromAPIKeyFactory,
  getServicesFactory,
  getUnsecuredServicesFactory,
} from '../lib/executor_services';
import { createSubActionConnectorFramework } from '../sub_action_framework';
import { SubActionConnector } from '../sub_action_framework/sub_action_connector';
import { CaseConnector } from '../sub_action_framework/case';
import { RelayClient } from '../lib/relay/relay_client';
import { getAxiosInstanceWithAuth } from '../lib/get_axios_instance';
import { createActionsEventLogSavedObjectProvider } from '../lib/event_log_saved_object_provider';

/** What a rule run calls on the actions plugin when it enqueues the actions of its alerts. */
export type RuleRunActionsStart = Pick<
  PluginStartContract,
  | 'getRelayClient'
  | 'getUnsecuredActionsClient'
  | 'getActionsClientWithRequest'
  | 'isActionExecutable'
  | 'renderActionParameterTemplates'
  | 'isSystemActionConnector'
  | 'isActionTypeEnabled'
> &
  Pick<PluginSetupContract, 'getActionsConfigurationUtilities'>;

/** The part of the actions setup contract that connector types are registered through. */
export type RuleRunActionsSetup = Pick<
  PluginSetupContract,
  | 'registerType'
  | 'registerSubActionConnectorType'
  | 'getActionsConfigurationUtilities'
  | 'getSubActionConnectorClass'
  | 'getCaseConnectorClass'
  | 'isPreconfiguredConnector'
  | 'getClientLeasePool'
>;

export interface RuleRunActionsDeps {
  logger: Logger;
  /** The validated actions config, as Kibana has it. */
  config: ActionsConfig;
  getSystemIdentity?: () => SystemIdentity | undefined;
  /**
   * Kibana's final in-memory connectors (see `ActionsTaskProcessSettings`). Without them, which only
   * a process that was sent none has, they are rebuilt from the config, which cannot know what
   * Kibana learned after it read it: conflicts with saved connectors and connectors other plugins
   * registered.
   */
  inMemoryConnectors?: InMemoryConnector[];
  license$: Observable<ILicense>;
  elasticsearch: Pick<IClusterClient, 'asScoped' | 'asInternalUser'>;
  savedObjects: Pick<SavedObjectsServiceStart, 'getScopedClient' | 'createInternalRepository'>;
  getEncryptedSavedObjectsClient: (options: {
    includedHiddenTypes: string[];
  }) => EncryptedSavedObjectsClient;
  taskManager: Pick<TaskManagerStartContract, 'bulkSchedule' | 'aggregate'>;
  publicBaseUrl?: string;
  /**
   * The security plugin's authorization: the privileges of the connector are checked when a rule run
   * enqueues it, as in Kibana. Without it (security is off) nothing is checked.
   */
  authorization?: ConstructorParameters<typeof ActionsAuthorization>[0]['authorization'];
  getAuditLoggerWithRequest?: (
    request: KibanaRequest
  ) => ConstructorParameters<typeof ActionsClient>[0]['auditLogger'];
  /**
   * Set for rule types that execute connectors themselves in the process, such as attack discovery
   * calling a model connector: the executor is initialized as the actions plugin initializes it.
   * Without it nothing executes here, and the enqueued `actions:*` tasks are run by Kibana.
   */
  executor?: {
    security: SecurityServiceStart;
    eventLogger: IEventLogger;
    analyticsService: AnalyticsServiceStart;
    createInternalRepository: SavedObjectsServiceStart['createInternalRepository'];
  };
  /** The counter of the actions domain, which the actions client counts what it is asked to with. */
  usageCounter?: IUsageCounter;
  /** Records that a licensed connector type was used, as the licensing plugin does in Kibana. */
  featureUsage?: { notifyUsage: (featureName: string, usedAt?: number | Date) => void };
  /** Registers the connector types a rule run may enqueue, such as stack_connectors'. */
  registerConnectorTypes: (
    actions: RuleRunActionsSetup,
    context: { publicBaseUrl?: string }
  ) => void;
}

/** Builds the connector registry, execution services, and enqueuer used by a task execution. */
export const createRuleRunActions = (
  deps: RuleRunActionsDeps
): {
  actionsPlugin: RuleRunActionsStart;
  hasActionType: (id: string) => boolean;
  /** The ids of the connector types registered, for comparing with Kibana's. */
  getActionTypeIds: () => string[];
  stop: () => Promise<void>;
} => {
  const { logger, config } = deps;
  let eventLogReader: ReturnType<typeof createStandaloneEventLogClientService> | undefined;
  const configurationUtilities = getActionsConfigurationUtilities(config);
  const relayClient = config.relay
    ? new RelayClient({
        baseUrl: config.relay.url,
        configurationUtilities,
        logger: logger.get('relay-client'),
        useSystemIdentity: config.relay.uiam?.enabled ?? false,
        getSystemIdentity: () => deps.getSystemIdentity?.(),
      })
    : undefined;
  const licenseState = new LicenseState(deps.license$);
  // As the actions plugin does at start: using a licensed connector type is recorded.
  if (deps.featureUsage) licenseState.setNotifyUsage(deps.featureUsage.notifyUsage);
  const sentConnectors = deps.inMemoryConnectors;
  // A copy: connector types the process registers must not change what Kibana sent.
  const inMemoryConnectors = sentConnectors
    ? [...sentConnectors]
    : getInMemoryConnectorsFromConfig(config, logger);

  const actionTypeRegistry = new ActionTypeRegistry({
    licensing: {
      featureUsage: { register: () => undefined, notifyUsage: () => undefined },
    } as unknown as LicensingPluginSetup,
    // Registering a connector type would register the task type that runs it; Kibana does that.
    taskManager: { registerTaskDefinitions: () => undefined } as never,
    taskRunnerFactory: {} as never,
    actionsConfigUtils: configurationUtilities,
    licenseState,
    inMemoryConnectors,
  });
  const subActionFramework = createSubActionConnectorFramework({
    actionTypeRegistry,
    logger,
    actionsConfigUtils: configurationUtilities,
  });
  const clientLeasePool = new LeasePool<unknown>(logger);
  const setup: RuleRunActionsSetup = {
    registerType: (actionType) => {
      ensureSufficientLicense(actionType);
      actionTypeRegistry.register(actionType);
    },
    registerSubActionConnectorType: (connector) => subActionFramework.registerConnector(connector),
    getActionsConfigurationUtilities: () => configurationUtilities,
    getSubActionConnectorClass: () => SubActionConnector,
    getCaseConnectorClass: () => CaseConnector,
    isPreconfiguredConnector: (connectorId) =>
      inMemoryConnectors.some(
        (connector) => connector.isPreconfigured && connector.id === connectorId
      ),
    getClientLeasePool: () => clientLeasePool,
  };
  deps.registerConnectorTypes(setup, { publicBaseUrl: deps.publicBaseUrl });
  // Kibana's list already holds its system connectors.
  if (!sentConnectors)
    inMemoryConnectors.push(...createSystemConnectors(actionTypeRegistry.list()));

  const authTypeRegistry = new AuthTypeRegistry();
  registerAuthTypes(authTypeRegistry);
  const includedHiddenTypes = [
    ACTION_SAVED_OBJECT_TYPE,
    ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
    ALERT_SAVED_OBJECT_TYPE,
  ];
  const encryptedSavedObjectsClient = deps.getEncryptedSavedObjectsClient({ includedHiddenTypes });
  const bulkExecutionEnqueuer = createBulkExecutionEnqueuerFunction({
    taskManager: deps.taskManager as TaskManagerStartContract,
    actionTypeRegistry,
    isESOCanEncrypt: true,
    inMemoryConnectors,
    configurationUtilities,
    logger,
  });
  const actionExecutor = new ActionExecutor({
    isESOCanEncrypt: true,
    connectorRateLimiter: new ConnectorRateLimiter({ config: config.rateLimiter }),
  });
  const { executor } = deps;
  if (executor) {
    const getUnsecuredScopedClient = (request: KibanaRequest) =>
      deps.savedObjects.getScopedClient(request, {
        excludedExtensions: [SECURITY_EXTENSION_ID],
        includedHiddenTypes,
      });
    actionExecutor.initialize({
      logger,
      eventLogger: executor.eventLogger,
      // A run has one space, the one its request names.
      spaces: {
        getSpaceId: (request?: KibanaRequest) =>
          (request as { spaceId?: string } | undefined)?.spaceId ?? 'default',
      } as unknown as SpacesServiceStart,
      security: executor.security,
      getServices: getServicesFactory({
        logger,
        getScopedClient: (request) =>
          deps.savedObjects.getScopedClient(request, { includedHiddenTypes }),
        elasticsearch: { client: deps.elasticsearch },
        encryptedSavedObjectsClient,
        unsecuredSavedObjectsClient: getUnsecuredScopedClient,
        configurationUtilities,
      }),
      getUnsecuredServices: getUnsecuredServicesFactory({
        logger,
        getSavedObjectRepository: () => executor.createInternalRepository(includedHiddenTypes),
        elasticsearch: { client: deps.elasticsearch },
        encryptedSavedObjectsClient,
        unsecuredSavedObjectsRepository: () =>
          getUnsecuredScopedClient({ headers: {} } as unknown as KibanaRequest),
        configurationUtilities,
      }),
      encryptedSavedObjectsClient,
      actionTypeRegistry,
      inMemoryConnectors,
      getActionsAuthorizationWithRequest: (request: KibanaRequest) =>
        new ActionsAuthorization({ request, authorization: deps.authorization }),
      analyticsService: executor.analyticsService,
      getCurrentUserProfileIdFromAPIKey: getCurrentUserProfileIdFromAPIKeyFactory({
        logger,
        elasticsearch: { client: deps.elasticsearch },
      }),
    });
  }

  const getActionsClientWithRequest = async (request: KibanaRequest): Promise<ActionsClient> => {
    const unsecuredSavedObjectsClient = deps.savedObjects.getScopedClient(request, {
      excludedExtensions: [SECURITY_EXTENSION_ID],
      includedHiddenTypes,
    });
    return new ActionsClient({
      publicBaseUrl: deps.publicBaseUrl,
      connectorSigningKeysEnabled: config.connectorSigningKeys.enabled,
      logger,
      unsecuredSavedObjectsClient,
      actionTypeRegistry,
      authTypeRegistry,
      kibanaIndices: ['.kibana', '.kibana_alerting_cases'],
      scopedClusterClient: deps.elasticsearch.asScoped(request),
      inMemoryConnectors,
      request,
      authorization: new ActionsAuthorization({ request, authorization: deps.authorization }),
      auditLogger: deps.getAuditLoggerWithRequest?.(request),
      actionExecutor,
      bulkExecutionEnqueuer,
      usageCounter: deps.usageCounter as UsageCounter | undefined,
      connectorTokenClient: new ConnectorTokenClient({
        unsecuredSavedObjectsClient,
        encryptedSavedObjectsClient,
        logger,
        configurationUtilities,
      }),
      getEventLogClient: async () => {
        eventLogReader ??= createStandaloneEventLogClientService({
          asInternalUser: deps.elasticsearch.asInternalUser,
          logger: logger.get('eventLogReader'),
          savedObjects: deps.savedObjects,
          providers: {
            action: createActionsEventLogSavedObjectProvider(getActionsClientWithRequest),
          },
        });
        return eventLogReader.clientService.getClient(request);
      },
      getAxiosInstanceWithAuth: getAxiosInstanceWithAuth({
        authTypeRegistry,
        configurationUtilities,
        logger,
      }),
      isESOCanEncrypt: true,
      encryptedSavedObjectsClient,
    } as ConstructorParameters<typeof ActionsClient>[0]);
  };

  return {
    actionsPlugin: {
      getActionsConfigurationUtilities: () => configurationUtilities,
      getRelayClient: () => relayClient,
      getUnsecuredActionsClient: () =>
        new UnsecuredActionsClient({
          actionExecutor,
          clusterClient: deps.elasticsearch as IClusterClient,
          executionEnqueuer: createBulkUnsecuredExecutionEnqueuerFunction({
            taskManager: deps.taskManager,
            connectorTypeRegistry: actionTypeRegistry,
            inMemoryConnectors,
            configurationUtilities,
          }),
          inMemoryConnectors,
          internalSavedObjectsRepository: deps.savedObjects.createInternalRepository([
            ACTION_SAVED_OBJECT_TYPE,
            ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
          ]),
          kibanaIndices: ['.kibana', '.kibana_alerting_cases'],
          logger,
          connectorTypeRegistry: actionTypeRegistry,
        }),
      getActionsClientWithRequest,
      isActionTypeEnabled: (id, options = { notifyUsage: false }) =>
        actionTypeRegistry.isActionTypeEnabled(id, options),
      isActionExecutable: (actionId, actionTypeId, options) =>
        actionTypeRegistry.isActionExecutable(actionId, actionTypeId, options),
      renderActionParameterTemplates: (...args) =>
        renderActionParameterTemplates(logger, actionTypeRegistry, ...args),
      isSystemActionConnector: (connectorId) =>
        inMemoryConnectors.some(
          (connector) => connector.id === connectorId && connector.isSystemAction
        ),
    },
    hasActionType: (id) => actionTypeRegistry.has(id),
    getActionTypeIds: () => actionTypeRegistry.getAllTypes(),
    stop: async () => {
      licenseState.clean();
      clientLeasePool.stop();
      await eventLogReader?.stop();
    },
  };
};
