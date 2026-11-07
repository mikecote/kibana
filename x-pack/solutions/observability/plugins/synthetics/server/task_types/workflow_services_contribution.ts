/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { ObservabilityAgentBuilderDataRegistryTypes } from '@kbn/observability-agent-builder-plugin/server';
import { createSyntheticsMonitorDetailsDataProvider } from '../agent_builder/register_data_provider';
import { MonitorConfigRepository } from '../services/monitor_config_repository';
import {
  getLegacySyntheticsMonitorSavedObjectType,
  LEGACY_SYNTHETICS_MONITOR_ENCRYPTED_TYPE_SINGLE,
} from '../saved_objects/synthetics_monitor/legacy_synthetics_monitor';
import {
  getSyntheticsMonitorConfigSavedObjectType,
  SYNTHETICS_MONITOR_ENCRYPTED_TYPE,
} from '../saved_objects/synthetics_monitor/synthetics_monitor_config';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: ['synthetics'],
    createSavedObjectTypes: (encryption) => [
      getLegacySyntheticsMonitorSavedObjectType(encryption),
      getSyntheticsMonitorConfigSavedObjectType(),
    ],
    encryptedSavedObjectTypes: [
      LEGACY_SYNTHETICS_MONITOR_ENCRYPTED_TYPE_SINGLE,
      SYNTHETICS_MONITOR_ENCRYPTED_TYPE,
    ],
  },
  provides: {
    'observabilityAgentBuilder.dataProviders.synthetics': ({
      host: taskHost,
      settings,
    }): Pick<ObservabilityAgentBuilderDataRegistryTypes, 'syntheticsMonitorDetails'> => {
      if (!settings.synthetics)
        throw new Error('Synthetics is not enabled in the dispatching Kibana');
      const host = taskHost as TaskHost;
      const encryption = host.encryptedSavedObjects;
      if (!encryption)
        throw new Error('Synthetics requires native encrypted saved object services');
      return {
        syntheticsMonitorDetails: createSyntheticsMonitorDetailsDataProvider(
          async (request) =>
            new MonitorConfigRepository(
              host.savedObjects.getScopedClient(request),
              encryption.getClient()
            )
        ),
      };
    },
  },
  register: () => {},
};
