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
import type { SandboxTaskProcessRuntime } from '../../workflow_services_contribution';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services }) => {
    if (!services) throw new Error('Native Sandbox proof requires workflow services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.sandbox.stat',
        label: 'Native Sandbox stat',
        description: 'Exercises the native Sandbox provider and scoped session factory',
        category: StepCategory.Ai,
        inputSchema: z.object({ conversation_id: z.string().min(1).max(1024) }),
        outputSchema: z.object({ exists: z.boolean(), same_session: z.boolean() }),
        handler: async (context) => {
          const { sandbox } = services.getService<SandboxTaskProcessRuntime>('sandbox.runtime');
          if (!sandbox) throw new Error('Main did not configure Sandbox');
          const { spaceId } = context.contextManager.getContext().workflow;
          const session = sandbox.getSessionForSpace(spaceId, context.input.conversation_id);
          const files = await session.statFiles(['/workspace']);
          return {
            output: {
              exists: files.some((file) => file.path === '/workspace' && file.exists),
              same_session:
                session ===
                sandbox.getSession(
                  context.contextManager.getFakeRequest(),
                  context.input.conversation_id
                ),
            },
          };
        },
      })
    );
  },
};
