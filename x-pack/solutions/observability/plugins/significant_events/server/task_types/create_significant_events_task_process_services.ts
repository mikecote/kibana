/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import type { AgentBuilderContributionContext } from '@kbn/agent-builder-server';
import type { FieldsMetadataServerStart } from '@kbn/fields-metadata-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { SignificantEventsPluginStartDependencies } from '../types';
import type { GetScopedClients } from '../routes/types';
import type { SignificantEventsAuthorizationServices } from '../run_services/authorization';
import { createSignificantEventsAccessChecker } from '../run_services/create_access_checker';
import type { SignificantEventsAccessChecker } from '../run_services/create_access_checker';
import { createSignificantEventsScopedClients } from '../run_services/create_scoped_clients';
import { KnowledgeIndicatorService } from '../lib/knowledge_indicators';
import {
  createMaintenanceStateReader,
  createMaintenanceStateStore,
} from '../lib/maintenance/state_store';
import type { SignificantEventsMaintenanceService } from '../lib/maintenance/maintenance_service';
import { createSignificantEventsServices } from '../lib/significant_events/significant_events_clients';
import { isSignificantEventsFeatureFlagEnabled } from '../lib/feature_flags/is_significant_events_feature_flag_enabled';
import { EbtTelemetryClient } from '../lib/telemetry/ebt/client';
import { createWorkflowClients } from '../lib/workflows/create_workflow_clients';
import type { WorkflowClients } from '../lib/workflows/create_workflow_clients';
import {
  SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID,
  type SignificantEventsTaskProcessSettings,
} from './significant_events_task_process_settings';

export interface SignificantEventsTaskProcessServices {
  getScopedClients: GetScopedClients;
  server: SignificantEventsAuthorizationServices;
  access: SignificantEventsAccessChecker;
  telemetry: EbtTelemetryClient;
  maintenanceService: Pick<SignificantEventsMaintenanceService, 'getState'>;
  workflowClients: WorkflowClients;
}

const runtimes = new WeakMap<TaskHost, SignificantEventsTaskProcessServices>();

/** Resolves the shared significant events clients using this execution's native services. */
export const getSignificantEventsTaskProcessServices = (
  context: AgentBuilderContributionContext
): SignificantEventsTaskProcessServices => {
  const host = context.host as TaskHost;
  const existing = runtimes.get(host);
  if (existing) return existing;
  const snapshot = context.settings[SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID] as
    | SignificantEventsTaskProcessSettings
    | undefined;
  if (!snapshot) throw new Error('Significant events requires its registration snapshot');
  const getExecutionServices = () => {
    const { dataStreams, featureFlags, uiSettings, licensing } = host;
    const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
    if (!dataStreams || !featureFlags || !uiSettings || !licensing || !security) {
      throw new Error('Significant events requires native execution services');
    }
    return { dataStreams, featureFlags, uiSettings, licensing, security };
  };
  const { services, logger } = context;
  const getLicense = () => firstValueFrom(getExecutionServices().licensing.license$);
  const access = createSignificantEventsAccessChecker({
    isFeatureEnabled: () =>
      isSignificantEventsFeatureFlagEnabled(getExecutionServices().featureFlags),
    isDeploymentSupported: () => snapshot.availability.deploymentSupported,
    isPricingTierAvailable: () => snapshot.availability.pricingTierAvailable,
    getLicense,
    hasPlugin: (plugin) => snapshot.availability.requiredPlugins.includes(plugin),
  });
  const getSources = () =>
    services.getService<SignificantEventsPluginStartDependencies['nightshiftSources']>(
      'nightshiftSources'
    );
  const telemetry = new EbtTelemetryClient({
    reportEvent: (...args) => host.analytics.reportEvent(...args),
  });
  const workflowClients = createWorkflowClients(
    snapshot.availability.requiredPlugins.includes('workflowsManagement')
      ? (services.getWorkflowsManagement() as WorkflowsServerPluginSetup['management'])
      : undefined,
    telemetry,
    (request) => getSources().getSourcesClient({ request })
  );
  const maintenanceService = createMaintenanceStateReader(
    createMaintenanceStateStore(() => host.savedObjects)
  );
  const getScopedClients = createSignificantEventsScopedClients({
    getStartServices: async () => {
      const { dataStreams, uiSettings } = getExecutionServices();
      return {
        coreStart: {
          elasticsearch: { client: host.elasticsearch },
          savedObjects: host.savedObjects,
          uiSettings,
          dataStreams,
        },
        pluginsStart: {
          inference: services.getInferenceStart() as InferenceServerStart,
          licensing: { getLicense },
          fieldsMetadata: services.getService<FieldsMetadataServerStart>('fieldsMetadata'),
          nightshiftSources: getSources(),
          alertingVTwo:
            services.getService<
              Pick<
                SignificantEventsPluginStartDependencies['alertingVTwo'],
                'getAlertEventsClientWithRequest' | 'getRulesClientWithRequestInSpace'
              >
            >('alertingVTwo'),
          ...(snapshot.availability.requiredPlugins.includes('workflowsExtensions')
            ? {
                workflowsExtensions:
                  services.getService<WorkflowsExtensionsServerPluginStart>('workflows.extensions'),
              }
            : {}),
        },
      };
    },
    getCpsEnabled: () => snapshot.cpsEnabled,
    significantEventsServices: createSignificantEventsServices(),
    knowledgeIndicatorService: new KnowledgeIndicatorService(async () => {
      const { dataStreams, featureFlags } = getExecutionServices();
      return { dataStreams, featureFlags };
    }, logger),
    getOnboardingClient: () => workflowClients.streamsKIsOnboardingClient,
    getMaintenanceService: () => maintenanceService,
    logger,
  });
  const runtime = {
    getScopedClients,
    server: {
      security: {
        get authz() {
          return getExecutionServices().security.authz;
        },
      },
    },
    access,
    telemetry,
    maintenanceService,
    workflowClients,
  };
  runtimes.set(host, runtime);
  return runtime;
};
