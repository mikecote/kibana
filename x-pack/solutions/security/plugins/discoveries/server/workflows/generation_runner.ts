/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { executeGenerationWorkflow } from '@kbn/discoveries/impl/attack_discovery/generation/execute_generation_workflow';
import type { z } from '@kbn/zod/v4';
import { RunStepOutputSchema } from '../../common/step_types/run_step';
import type { RunStepInputSchema } from '../../common/step_types/run_step';

export type GenerationRunner = (args: {
  params: Parameters<typeof executeGenerationWorkflow>[0];
  input: z.input<typeof RunStepInputSchema>;
  mode: 'sync' | 'async';
  spaceId: string;
  waitSignal?: AbortSignal;
}) => Promise<z.infer<typeof RunStepOutputSchema>>;

/** Runs generation using the services owned by the long-lived Kibana plugin. */
export const runInlineGeneration: GenerationRunner = async ({ params, mode }) => {
  const pipeline = executeGenerationWorkflow(params);
  if (mode === 'async') {
    void pipeline.catch((error) => {
      params.logger.error(
        `Async Attack Discovery run failed (execution=${params.executionUuid}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    return { execution_uuid: params.executionUuid, status: 'pending' };
  }
  const outcome = await pipeline;
  if (outcome.outcome === 'validation_succeeded') {
    return RunStepOutputSchema.parse({
      alerts_context_count: outcome.alertRetrievalResult.alertsContextCount,
      attack_discoveries: outcome.generationResult.attackDiscoveries,
      discovery_count: outcome.validationResult.generatedCount,
      execution_uuid: outcome.generationResult.executionUuid,
      status: 'completed',
    });
  }
  params.logger.warn(`Attack Discovery tool validation failed (execution=${params.executionUuid})`);
  return {
    alerts_context_count: 0,
    attack_discoveries: null,
    discovery_count: 0,
    execution_uuid: params.executionUuid,
    status: 'completed',
  };
};
