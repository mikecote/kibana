/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ExecutionError } from '@kbn/workflows/server';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import { CONTEXT_ENGINE_ENABLED_SETTING_ID } from '@kbn/management-settings-ids';
import { VerifyKiStepCommonDefinition } from '../../common/step_types/verify_ki_step';
import { omitNullKiAttributes } from '../../common/step_types/ki';
import type { VerifyKi } from './verify_ki';

/**
 * The verify KI step. Whether the Context Engine is on in a space is read through
 * `isContextEngineEnabled`, which Kibana builds from its start contracts and a task process from its host.
 */
export const createVerifyKiStepDefinition = (
  isContextEngineEnabled: (spaceId: string) => Promise<boolean>,
  verifyKi: VerifyKi
) =>
  createServerStepDefinition({
    ...VerifyKiStepCommonDefinition,
    handler: async (context) => {
      const { spaceId } = context.contextManager.getContext().workflow;
      const isEnabled = await isContextEngineEnabled(spaceId);
      if (!isEnabled) {
        throw new ExecutionError({
          type: 'FeatureDisabledError',
          message: `Context Engine is disabled. Enable the ${CONTEXT_ENGINE_ENABLED_SETTING_ID} advanced setting to verify knowledge indicators.`,
        });
      }

      const {
        ki,
        verifiers,
        ai_index_id: aiIndexId,
        total_timeout_sec: totalTimeoutSec,
      } = context.input;
      const summary = await verifyKi({
        context,
        ki: omitNullKiAttributes(ki),
        verifiers,
        aiIndexId,
        totalTimeoutSec,
      });
      return { output: summary };
    },
  });
