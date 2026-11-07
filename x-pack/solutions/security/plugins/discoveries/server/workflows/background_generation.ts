/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { stringify } from 'yaml';
import { z, lazySchema } from '@kbn/zod/v4';
import type { KibanaRequest } from '@kbn/core/server';
import { ExecutionStatus } from '@kbn/workflows';
import type {
  WorkflowExecutionEngineModel,
  WorkflowYaml,
  EsWorkflowExecution,
} from '@kbn/workflows';
import { pollForWorkflowCompletion } from '@kbn/discoveries/impl/attack_discovery/generation/poll_for_workflow_completion';
import type { WorkflowsManagementApi } from '@kbn/discoveries/impl/attack_discovery/generation/types';
import type { RunStepInputSchema } from '../../common/step_types/run_step';
import { RunStepTypeId, RunStepOutputSchema } from '../../common/step_types/run_step';

import { ApiConfigSchema } from '../../common/step_types/shared_schemas';
import type { GenerationRunner } from './generation_runner';

const metadataSchema = lazySchema(() =>
  z.object({
    executionUuid: z.uuid(),
    source: z.enum(['agent_builder', 'workflow']),
  })
);

export type BackgroundGenerationMetadata = z.infer<typeof metadataSchema>;

/** Reads the correlation and result policy of a durably scheduled discovery pipeline. */
export const getBackgroundGenerationMetadata = (
  execution:
    | Readonly<
        Pick<
          EsWorkflowExecution,
          'workflowId' | 'isEphemeral' | 'managed' | 'managedBy' | 'metadata'
        >
      >
    | undefined
): BackgroundGenerationMetadata | undefined => {
  if (
    !execution ||
    execution.isEphemeral !== true ||
    execution.managed !== true ||
    execution.managedBy !== 'discoveries' ||
    !execution.workflowId.startsWith('attack-discovery-')
  )
    return undefined;
  const expectedUuid = z.uuid().safeParse(execution.workflowId.slice('attack-discovery-'.length));
  if (!expectedUuid.success) return undefined;
  const metadata = metadataSchema.parse(execution.metadata?.attackDiscovery);
  if (metadata.executionUuid !== expectedUuid.data)
    throw new Error('Queued Discovery generation correlation does not match its workflow');
  return metadata;
};

/** Schedules the existing synchronous pipeline as a separately owned workflow task. */
export const scheduleBackgroundGeneration = ({
  input,
  metadata,
  request,
  spaceId,
  workflowsManagementApi,
}: {
  input: z.input<typeof RunStepInputSchema>;
  metadata: BackgroundGenerationMetadata;
  request: KibanaRequest;
  spaceId: string;
  workflowsManagementApi: WorkflowsManagementApi;
}): Promise<string> => {
  const definition: WorkflowYaml = {
    name: 'Attack Discovery generation',
    enabled: true,
    version: '1',
    settings: { timeout: '1h' },
    triggers: [{ type: 'manual' }],
    outputs: {
      type: 'object',
      properties: { result: { type: 'object', additionalProperties: true } },
      required: ['result'],
    },
    steps: [
      {
        name: 'pipeline',
        type: RunStepTypeId,
        timeout: '1h',
        with: { ...input, mode: 'sync' },
      },
      {
        name: 'result',
        type: 'workflow.output',
        with: { result: '${{ steps.pipeline.output }}' },
      },
    ],
  };
  const workflow: WorkflowExecutionEngineModel = {
    id: `attack-discovery-${metadata.executionUuid}`,
    name: definition.name,
    enabled: true,
    definition,
    yaml: stringify(definition),
    isEphemeral: true,
    managed: true,
    managedBy: 'discoveries',
    billable: false,
  };
  return workflowsManagementApi.scheduleWorkflow(workflow, spaceId, {}, request, metadata.source, {
    attackDiscovery: metadata,
  });
};

/** Runs generation in a durable child workflow and waits only when the caller requests a result. */
export const createDurableGenerationRunner =
  (workflowsManagementApi: WorkflowsManagementApi): GenerationRunner =>
  async ({ params, input, mode, waitSignal, spaceId }) => {
    waitSignal?.throwIfAborted();
    const metadata = metadataSchema.parse({
      executionUuid: params.executionUuid,
      source: params.trigger,
    });
    const apiConfig = ApiConfigSchema.parse(params.apiConfig);
    const executionId = await scheduleBackgroundGeneration({
      input: { ...input, connector_id: apiConfig.connector_id },
      metadata,
      request: params.request,
      spaceId,
      workflowsManagementApi,
    });
    const pending = { execution_uuid: params.executionUuid, status: 'pending' as const };
    if (mode === 'async') return pending;
    try {
      const execution = await pollForWorkflowCompletion({
        executionId,
        logger: params.logger,
        request: params.request,
        spaceId,
        workflowsManagementApi,
        signal: waitSignal,
      });
      if (execution.status !== ExecutionStatus.COMPLETED) {
        const message =
          typeof execution.error === 'string' ? execution.error : execution.error?.message;
        throw new Error(message ?? `Attack Discovery workflow ${executionId} ${execution.status}`);
      }
      return z.object({ result: RunStepOutputSchema }).parse(execution.context?.output).result;
    } catch (error) {
      if (waitSignal?.aborted) return pending;
      throw error;
    }
  };
