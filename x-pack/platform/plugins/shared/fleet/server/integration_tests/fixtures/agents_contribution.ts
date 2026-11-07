/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import {
  AGENT_POLICY_SAVED_OBJECT_TYPE,
  PRECONFIGURATION_DELETION_RECORD_SAVED_OBJECT_TYPE,
} from '../../constants';
import type { FleetWorkflowRunServices } from '../../services/run_time/workflow_run_services';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, services }) => {
    if (!services) throw new Error('Fleet proof requires native workflow services');
    const taskHost = host as TaskHost;
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.fleet.agents',
        label: 'Native Fleet agents',
        description: 'Read enrolled agents through Fleet’s space-scoped native service',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          agentIds: z.array(z.string()),
          policyNamespaceType: z.string(),
          preconfigurationNamespaceType: z.string(),
        }),
        handler: async (context) => {
          const fleet = await services
            .getService<FleetWorkflowRunServices>('fleet.runServices')
            .getServices();
          const spaceId = context.contextManager.getContext().workflow.spaceId;
          const { agents } = await fleet.agentService.asInternalScopedUser(spaceId).listAgents({
            kuery: 'local_metadata.host.hostname:"shared-host"',
            showInactive: false,
            perPage: 2,
          });
          const policyType = taskHost.savedObjects
            .getTypeRegistry()
            .getType(AGENT_POLICY_SAVED_OBJECT_TYPE);
          const preconfigurationType = taskHost.savedObjects
            .getTypeRegistry()
            .getType(PRECONFIGURATION_DELETION_RECORD_SAVED_OBJECT_TYPE);
          if (!policyType || !preconfigurationType) {
            throw new Error('Native Fleet saved-object definitions are missing');
          }
          return {
            output: {
              agentIds: agents.map(({ id }) => id),
              policyNamespaceType: policyType.namespaceType,
              preconfigurationNamespaceType: preconfigurationType.namespaceType,
            },
          };
        },
      })
    );
  },
};
