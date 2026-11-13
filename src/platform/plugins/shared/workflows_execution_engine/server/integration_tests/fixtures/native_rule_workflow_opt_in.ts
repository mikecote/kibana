/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { AlertingConnectorFeatureId, SecurityConnectorFeatureId } from '@kbn/actions-plugin/common';
import type { RuleRunContribution } from '@kbn/alerting-plugin/server/task_types/rule_run_contribution';
import type { KibanaRequest } from '@kbn/core/server';
import type { SerializableRecord } from '@kbn/utility-types';
import { toWorkflowExecutionEngineModel } from '@kbn/workflows';
import type { WorkflowDetailDto, WorkflowExecutionEngineModel } from '@kbn/workflows';
import { validateWorkflowForExecution } from '@kbn/workflows/server';
import { lazySchema, z } from '@kbn/zod/v4';

interface InlineWorkflowManagement {
  getWorkflow: (
    id: string,
    spaceId: string,
    request: KibanaRequest
  ) => Promise<WorkflowDetailDto | null>;
  runWorkflow: (
    workflow: WorkflowExecutionEngineModel,
    spaceId: string,
    inputs: SerializableRecord,
    request: KibanaRequest
  ) => Promise<string>;
}
const paramsSchema = lazySchema(() =>
  z.object({
    workflowId: z.string().max(200),
    spaceId: z.string().max(200),
  })
);

export const contribution: RuleRunContribution = {
  register: ({ actions, alerting }, context) => {
    alerting.enableAlertStatusChanged({ isEnabled: async () => true });
    actions.registerType<{}, {}, z.infer<typeof paramsSchema>, { workflowRunId: string }>({
      id: '.test-native-workflow-run',
      name: 'Native inline workflow proof',
      minimumLicenseRequired: 'gold',
      supportedFeatureIds: [AlertingConnectorFeatureId, SecurityConnectorFeatureId],
      isSystemActionType: true,
      validate: {
        config: { schema: z.object({}).strict() },
        secrets: { schema: z.object({}).strict() },
        params: {
          schema: paramsSchema,
        },
      },
      executor: async ({ params, request, actionId }) => {
        if (!context.getService || !request)
          throw new Error('Native workflow execution is required');
        const api = context.getService<InlineWorkflowManagement>('workflows.management');
        const workflow = await api.getWorkflow(params.workflowId, params.spaceId, request);
        validateWorkflowForExecution(workflow, params.workflowId);
        const workflowRunId = await api.runWorkflow(
          toWorkflowExecutionEngineModel(workflow),
          params.spaceId,
          {},
          request
        );
        return { status: 'ok', actionId, data: { workflowRunId } };
      },
    });
  },
};
