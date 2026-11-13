/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import type { SLOServerStart } from '../types';
import { slo, sloSettings } from '../saved_objects';
import { createScopedSloClient } from '../client/create_scoped_slo_client';
import { createSloDetailsDataProvider } from '../agent_builder/register_data_provider';

export const contribution: WorkflowStepsContribution = {
  declares: { settings: ['sloRuntime'], savedObjectTypes: [slo, sloSettings] },
  provides: {
    slo: ({ host: taskHost, services, settings }): SLOServerStart => {
      const snapshot = settings.sloRuntime as
        | { enabled: boolean; spacesEnabled: boolean }
        | undefined;
      if (!snapshot?.enabled) throw new Error('SLO is not enabled in the dispatching Kibana');
      if (!services) throw new Error('SLO requires workflow execution services');
      const host = taskHost as TaskHost;
      const spaces = snapshot.spacesEnabled
        ? services.getService<SpacesPluginStart>('spaces')
        : undefined;
      return {
        getSloClientWithRequest: createScopedSloClient({
          savedObjects: host.savedObjects,
          elasticsearch: { client: host.elasticsearch },
          getSpaceId: async (request) =>
            (await spaces?.spacesService.getActiveSpace(request))?.id ?? 'default',
          logger: host.logger.get('slo'),
        }),
      };
    },
    'observabilityAgentBuilder.dataProviders.slo': ({
      services,
    }): Pick<ObservabilityAgentBuilderDataRegistryTypes, 'sloDetails'> => {
      if (!services) throw new Error('SLO data providers require workflow execution services');
      const client = services.getService<SLOServerStart>('slo');
      return { sloDetails: createSloDetailsDataProvider(client.getSloClientWithRequest) };
    },
  },
  register: () => {},
};
