/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginStart } from '@kbn/agent-builder-server';
import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import { LinkedProjectsService } from '@kbn/cps/server/linked_projects/linked_projects_service';
import type { StandaloneSearch } from '@kbn/data-plugin/server/search/standalone_search';
import type { FleetWorkflowRunServices } from '@kbn/fleet-plugin/server/services/run_time/workflow_run_services';
import { createOsqueryActionService } from '@kbn/osquery-plugin/server/run_time/create_osquery_action_service';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContributionServices } from '@kbn/workflows-extensions/server';
import { TelemetryConfigProvider } from '../../common/telemetry_config/telemetry_config_provider';
import { createEndpointCpsResolver } from '../endpoint/services/create_cps_resolver';
import { createNativeProductFeaturesReader } from '../lib/product_features_service';
import {
  createEndpointResponseActionsRunServices,
  type EndpointResponseActionsRunServices,
} from '../endpoint/run_time/create_endpoint_response_actions_run_services';
import type { SecurityAgentBuilderSettings } from './agent_builder_settings';

export interface EndpointWorkflowServices {
  getServices: () => Promise<EndpointResponseActionsRunServices>;
}

/** Builds Endpoint's execution services lazily from the dispatch configuration and native SDKs. */
export const createEndpointWorkflowServices = (
  host: TaskHost,
  snapshot: SecurityAgentBuilderSettings,
  services: WorkflowStepsContributionServices
): EndpointWorkflowServices => {
  let pending: Promise<EndpointResponseActionsRunServices> | undefined;
  const build = async (): Promise<EndpointResponseActionsRunServices> => {
    if (!host.licensing || !host.onRunEnd)
      throw new Error('Native Endpoint requires licensing and run lifecycle services');
    const fleetRunServices = await services
      .getService<FleetWorkflowRunServices>('fleet.runServices')
      .getServices();
    const loggerFactory = {
      get: (...parts: string[]) => host.logger.get('securitySolution', ...parts),
    };
    const telemetryConfigProvider = new TelemetryConfigProvider(snapshot.telemetryOptIn);
    const linkedProjects = new LinkedProjectsService(loggerFactory.get('cps'), {
      client: host.elasticsearch,
    });
    const shared = {
      fleetRunServices,
      elasticsearch: host.elasticsearch,
      savedObjects: host.savedObjects,
      license$: host.licensing.license$,
      loggerFactory,
      analytics: host.analytics,
    };
    const endpoint = await createEndpointResponseActionsRunServices({
      ...shared,
      config: snapshot.config,
      experimentalFeatures: snapshot.config.experimentalFeatures,
      cloud: snapshot.cloud,
      security: host.security,
      featureUsage: host.licensing.featureUsage,
      connectorActions:
        services.getService<Pick<ActionsPluginStart, 'getUnsecuredActionsClient'>>('actions'),
      osqueryActionService: snapshot.plugins.osquery
        ? await createOsqueryActionService(shared)
        : undefined,
      executionServices: {
        productFeaturesService: createNativeProductFeaturesReader(snapshot.productFeatures),
        telemetryConfigProvider,
        clusterClient: host.elasticsearch,
        dataStart: { search: services.getService<StandaloneSearch>('data.search') },
        spacesService: services.getService<SpacesPluginStart>('spaces').spacesService,
        isCpsActive: createEndpointCpsResolver(
          snapshot.config.experimentalFeatures.defendCrossProjectSearch,
          snapshot.cpsAvailable ? (request) => linkedProjects.isCpsActive(request) : undefined
        ),
        agentBuilder: () => services.getService<AgentBuilderPluginStart>('agentBuilder'),
      },
    });
    host.onRunEnd(async () => {
      endpoint.stop();
      telemetryConfigProvider.stop();
    });
    return endpoint;
  };
  return { getServices: () => (pending ??= build()) };
};
