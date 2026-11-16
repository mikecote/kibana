/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock, httpServerMock, httpServiceMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { StepCategory } from '@kbn/workflows';
import {
  createPollServerStepDefinition,
  createServerStepDefinition,
} from '@kbn/workflows-extensions/server';
import { z } from '@kbn/zod/v4';
import { INVOKE_STEP_ROUTE_PATH, registerInvokeStepRoute } from './invoke_step';
import type { InvokeStepBody, InvokeStepResponseBody } from './invoke_step';

describe('registerInvokeStepRoute', () => {
  const logger = loggerMock.create();
  const coreStart = coreMock.createStart();
  const common = { label: 'Test step', description: 'A test step', category: StepCategory.Data };

  const setupRoute = (getStepDefinition: (id: string) => unknown) => {
    const router = httpServiceMock.createRouter();
    registerInvokeStepRoute(
      router,
      async () => [coreStart, { workflowsExtensions: { getStepDefinition } as never }],
      logger
    );
    const [routeConfig, handler] = router.post.mock.calls[0];
    return { routeConfig, handler };
  };

  const callRoute = async (handler: Function, body: Partial<InvokeStepBody>) => {
    const request = httpServerMock.createKibanaRequest({ body });
    const response = httpServerMock.createResponseFactory();
    await handler({} as never, request, response);
    return response;
  };

  it('registers an internal POST route with authz disabled', () => {
    const { routeConfig } = setupRoute(() => undefined);
    expect(routeConfig.path).toBe(INVOKE_STEP_ROUTE_PATH);
    expect(routeConfig.options?.access).toBe('internal');
    expect(routeConfig.security?.authz).toHaveProperty('enabled', false);
  });

  it('declines with notFound when the step type is not registered here', async () => {
    const { handler } = setupRoute(() => undefined);
    const response = await callRoute(handler, {
      phase: 'run',
      stepId: 's1',
      stepType: 'missing.step',
      input: {},
    });
    expect(response.notFound).toHaveBeenCalledTimes(1);
  });

  it('runs a one-shot step handler and returns its output', async () => {
    const definition = createServerStepDefinition({
      id: 'custom.oneShot',
      ...common,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: async (context) => ({ output: { echoed: context.input } }),
    });
    const { handler } = setupRoute((id) => (id === definition.id ? definition : undefined));

    const response = await callRoute(handler, {
      phase: 'run',
      stepId: 's1',
      stepType: definition.id,
      input: { a: 1 },
    });

    expect(response.ok).toHaveBeenCalledTimes(1);
    const body = response.ok.mock.calls[0][0]!.body as InvokeStepResponseBody;
    expect(body.output).toEqual({ echoed: { a: 1 } });
    expect(body.error).toBeUndefined();
  });

  it('serializes a thrown handler error instead of rejecting', async () => {
    const definition = createServerStepDefinition({
      id: 'custom.throwing',
      ...common,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: async () => {
        throw new Error('boom');
      },
    });
    const { handler } = setupRoute(() => definition);

    const response = await callRoute(handler, {
      phase: 'run',
      stepId: 's1',
      stepType: definition.id,
      input: {},
    });

    expect(response.ok).toHaveBeenCalledTimes(1);
    const body = response.ok.mock.calls[0][0]!.body as InvokeStepResponseBody;
    expect(body.error?.message).toBe('boom');
  });

  it('runs a poll step start phase and returns a continuation state', async () => {
    const definition = createPollServerStepDefinition({
      id: 'custom.poll',
      ...common,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      start: async () => ({ state: { jobId: 'abc' } }),
      poll: async () => ({ output: { done: true } }),
    });
    const { handler } = setupRoute(() => definition);

    const startResponse = await callRoute(handler, {
      phase: 'start',
      stepId: 's1',
      stepType: definition.id,
      input: {},
    });
    const startBody = startResponse.ok.mock.calls[0][0]!.body as InvokeStepResponseBody;
    expect(startBody.state).toEqual({ jobId: 'abc' });
    expect(startBody.output).toBeUndefined();

    const pollResponse = await callRoute(handler, {
      phase: 'poll',
      stepId: 's1',
      stepType: definition.id,
      input: {},
      state: { jobId: 'abc' },
      attempt: 1,
    });
    const pollBody = pollResponse.ok.mock.calls[0][0]!.body as InvokeStepResponseBody;
    expect(pollBody.output).toEqual({ done: true });
  });

  it('runs the cancel phase against onCancel without error', async () => {
    const onCancel = jest.fn();
    const definition = createServerStepDefinition({
      id: 'custom.cancellable',
      ...common,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      handler: async () => ({ output: {} }),
      onCancel,
    });
    const { handler } = setupRoute(() => definition);

    const response = await callRoute(handler, {
      phase: 'cancel',
      stepId: 's1',
      stepType: definition.id,
      input: {},
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(response.ok).toHaveBeenCalledTimes(1);
  });

  it('rejects a run phase against a poll-only step', async () => {
    const definition = createPollServerStepDefinition({
      id: 'custom.pollOnly',
      ...common,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      poll: async () => ({ output: {} }),
    });
    const { handler } = setupRoute(() => definition);

    const response = await callRoute(handler, {
      phase: 'run',
      stepId: 's1',
      stepType: definition.id,
      input: {},
    });

    expect(response.badRequest).toHaveBeenCalledTimes(1);
  });
});
