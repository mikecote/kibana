/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ContainerModule } from 'inversify';
import type { ServiceIdentifier } from 'inversify';
import { firstValueFrom } from 'rxjs';
import type { KibanaRequest, PluginOpaqueId } from '@kbn/core/server';
import { Setup, Start } from '@kbn/core-di';
import type { CoreDiServiceStart, ServiceToken } from '@kbn/core-di';
import { createSetupModule, createStartModule } from '@kbn/core-di-internal';
import { CoreInjectionService } from '@kbn/core-di-server-internal';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { IEventLogger } from '@kbn/event-log-plugin/server';
import { resolveRequestScoped } from '../agent_builder/resolve_request_scoped';
import { bindArtifactTypes } from '../setup/bind_artifact_types';
import { bindContract } from '../setup/bind_contract';
import { bindServices } from '../setup/bind_services';
import { bindEvents } from '../setup/bind_events';
import { bindRuleExecutionServices } from '../setup/bind_rule_executor';
import { bindDispatcherExecutionServices } from '../setup/bind_dispatcher_executor';
import { initSubscribers } from '../lib/events/init_subscribers';
import { AsyncDomainEventBus } from '../lib/events/event_bus';
import { EventLoggerToken } from '../lib/services/event_log_service/tokens';
import { EsqlResponseFormatService } from '../lib/services/esql_response_format_service/esql_response_format_service';
import { ResourceManager } from '../lib/services/resource_service/resource_manager';
import { ChangeHistoryClientToken } from '../lib/rule_changes_history';
import { initializeResources } from '../resources/register_resources';
import { ACTION_POLICY_EVENT_PROVIDER } from '../lib/dispatcher/steps/constants';
import type { AlertingServerStart } from '../types';
import {
  ALERTING_V2_TASK_PROCESS_SETTINGS_ID,
  type AlertingV2TaskProcessSettings,
} from './task_process_settings';

export interface AlertingV2RunServices {
  contract: AlertingServerStart;
  resolve: <T>(request: KibanaRequest, token: ServiceIdentifier<T>) => T;
  ready: () => Promise<void>;
}

/** Builds the plugin's client graph with execution-scoped Core and plugin services. */
export const createAlertingV2RunServices = ({
  host,
  workflowsManagement,
  workflowsExtensions,
  spaces,
  registerRunCompletion,
}: {
  host: TaskHost;
  workflowsManagement: WorkflowsServerPluginSetup['management'];
  workflowsExtensions: WorkflowsExtensionsServerPluginStart;
  spaces: SpacesPluginStart;
  registerRunCompletion: (complete: () => Promise<void>) => void;
}): AlertingV2RunServices => {
  const snapshot = host.settings?.[ALERTING_V2_TASK_PROCESS_SETTINGS_ID] as
    | AlertingV2TaskProcessSettings
    | undefined;
  const { featureFlags, uiSettings, userProfile, licensing, encryptedSavedObjects, eventLog } =
    host;
  if (
    !snapshot ||
    !featureFlags ||
    !uiSettings ||
    !userProfile ||
    !licensing ||
    !encryptedSavedObjects ||
    !eventLog ||
    !host.plugins?.security ||
    !host.onRunEnd
  ) {
    throw new Error('Alerting v2 requires its dispatch settings and execution services');
  }
  const logger = host.logger.get('alertingVTwo');
  const service = new CoreInjectionService();
  const pluginId = Symbol('alertingVTwo') as PluginOpaqueId;
  const container = service.setup().getContainer(pluginId);
  const start = service.start();
  const injection: CoreDiServiceStart = {
    getContainer: () => start.getContainer(pluginId),
    fork: () => start.fork(pluginId),
  };
  container.load(
    createSetupModule(
      {
        logger: { get: (...parts: string[]) => logger.get(...parts) },
        config: { get: () => snapshot.config },
        env: { packageInfo: { version: host.server.version } },
      },
      {},
      {
        workflowsManagement: { management: workflowsManagement },
        eventLog,
      }
    ),
    createStartModule(
      {
        injection,
        elasticsearch: { client: host.elasticsearch },
        savedObjects: host.savedObjects,
        security: host.security,
        userProfile,
        uiSettings,
        featureFlags,
        analytics: host.analytics,
        http: host.http,
      },
      {
        taskManager: host.taskManager,
        encryptedSavedObjects,
        security: host.plugins.security,
        licensing: { ...licensing, getLicense: () => firstValueFrom(licensing.license$) },
        spaces,
        workflowsExtensions,
      }
    ),
    new ContainerModule((options) => {
      bindArtifactTypes(options);
      bindContract(options);
      bindServices(options);
      bindEvents(options);
      bindRuleExecutionServices(options);
      bindDispatcherExecutionServices(options);
    })
  );
  container.bind(EventLoggerToken).toConstantValue(
    eventLog.getLogger({
      event: { provider: ACTION_POLICY_EVENT_PROVIDER },
    }) as IEventLogger
  );
  container.get(Setup);
  const contract = container.get(Start as ServiceToken<AlertingServerStart>);
  const resourceManager = container.get(ResourceManager);
  initializeResources({
    resourceManager,
    esClient: host.elasticsearch.asInternalUser,
    coreLogger: logger,
    changeHistoryClient: container.get(ChangeHistoryClientToken),
    userProfileService: userProfile,
    retention: snapshot.config.retention,
    install: false,
  });
  const stopSubscribers = initSubscribers(container);
  const eventBus = container.get(AsyncDomainEventBus);
  registerRunCompletion(() => eventBus.flush());
  const responseFormat = container.get(EsqlResponseFormatService);
  host.onRunEnd(async function disposeAlertingV2Runtime() {
    try {
      // Resource failures affect their consumers; unused initialization must still finish before cleanup.
      await Promise.allSettled([resourceManager.waitUntilReady()]);
    } finally {
      stopSubscribers();
      await eventBus.stop();
      responseFormat.stop();
      await container.unbindAllAsync();
    }
  });
  return {
    contract,
    resolve: (request, token) => resolveRequestScoped(injection, request, token),
    ready: () => resourceManager.waitUntilReady(),
  };
};
