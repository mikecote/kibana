/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { StepCategory } from '@kbn/workflows';
import { z } from '@kbn/zod/v4';
import { buildWorkflowStepIndex, buildWorkflowTriggerIndex } from './step_index';
import { createPollServerStepDefinition, createServerStepDefinition } from './step_registry/types';

const common = { label: 'Test step', description: 'A test step', category: StepCategory.Data };

describe('buildWorkflowStepIndex', () => {
  it('indexes a one-shot step with its config keys', () => {
    const definition = createServerStepDefinition({
      ...common,
      id: 'custom.oneShot',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      configSchema: z.object({ url: z.string(), timeout: z.number() }),
      handler: async () => ({ output: {} }),
      onCancel: async () => {},
    });

    expect(buildWorkflowStepIndex([definition])).toEqual([
      {
        id: 'custom.oneShot',
        kind: 'handler',
        configKeys: ['url', 'timeout'],
        hasOnCancel: true,
      },
    ]);
  });

  it('indexes a one-shot step with no configSchema as having no config keys', () => {
    const definition = createServerStepDefinition({
      ...common,
      id: 'custom.bare',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async () => ({ output: {} }),
    });

    expect(buildWorkflowStepIndex([definition])).toEqual([
      { id: 'custom.bare', kind: 'handler', configKeys: [], hasOnCancel: false },
    ]);
  });

  it('indexes a poll step with its policy, ceilings and start presence', () => {
    const definition = createPollServerStepDefinition({
      ...common,
      id: 'custom.poll',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      configSchema: z.object({ jobId: z.string() }),
      start: async () => ({ state: {} }),
      poll: async () => ({ output: {} }),
    });

    expect(buildWorkflowStepIndex([definition])).toEqual([
      {
        id: 'custom.poll',
        kind: 'poll',
        configKeys: ['jobId'],
        hasOnCancel: false,
        hasStart: true,
        policy: definition.policy,
        ceilings: definition.ceilings,
      },
    ]);
  });

  it('indexes a poll-only step (no start) accordingly', () => {
    const definition = createPollServerStepDefinition({
      ...common,
      id: 'custom.pollOnly',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      poll: async () => ({ output: {} }),
    });

    expect(buildWorkflowStepIndex([definition])[0]).toMatchObject({
      kind: 'poll',
      hasStart: false,
    });
  });
});

describe('buildWorkflowTriggerIndex', () => {
  it('carries the id and requiresConnectorId flag only when true', () => {
    const commonTrigger = {
      title: 'Test trigger',
      description: 'A test trigger',
      stability: 'stable' as const,
    };
    expect(
      buildWorkflowTriggerIndex([
        { ...commonTrigger, id: 'my-namespace.customTrigger', eventSchema: z.object({}) },
        {
          ...commonTrigger,
          id: 'slack2.app_mention',
          eventSchema: z.object({}),
          requiresConnectorId: true,
        },
      ])
    ).toEqual([
      { id: 'my-namespace.customTrigger' },
      { id: 'slack2.app_mention', requiresConnectorId: true },
    ]);
  });
});
