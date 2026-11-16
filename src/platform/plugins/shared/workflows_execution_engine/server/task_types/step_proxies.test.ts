/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PollHandlerContext, StepHandlerContext } from '@kbn/workflows-extensions/server';
import { isOneShotStepDefinition, isPollStepDefinition } from '@kbn/workflows-extensions/server';
import { buildStepProxyDefinition, buildTriggerProxyDefinition } from './step_proxies';
import { INVOKE_STEP_ROUTE_PATH } from '../routes/invoke_step';

const makeContext = (overrides: Partial<StepHandlerContext> = {}): StepHandlerContext => {
  const callKibanaApi = jest.fn();
  return {
    input: { a: 1 },
    rawInput: { a: 1 },
    config: {},
    contextManager: {
      getContext: () => ({} as never),
      getExecutionMetadata: () => ({} as never),
      getScopedEsClient: () => ({} as never),
      renderInputTemplate: ((value: unknown) => value) as never,
      createTemplateRenderer: () => ((value: unknown) => value) as never,
      getFakeRequest: () => ({} as never),
      callKibanaApi,
    },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    abortSignal: new AbortController().signal,
    stepId: 's1',
    stepType: 'custom.proxied',
    ...overrides,
  };
};

describe('buildStepProxyDefinition', () => {
  it('builds a one-shot proxy for a handler-kind index entry', () => {
    const definition = buildStepProxyDefinition({
      id: 'custom.oneShot',
      kind: 'handler',
      configKeys: [],
      hasOnCancel: false,
    });
    expect(isOneShotStepDefinition(definition)).toBe(true);
  });

  it("calls the invoke route with phase 'run' and returns the output", async () => {
    const definition = buildStepProxyDefinition({
      id: 'custom.oneShot',
      kind: 'handler',
      configKeys: [],
      hasOnCancel: false,
    });
    if (!isOneShotStepDefinition(definition)) throw new Error('expected a handler definition');
    const context = makeContext();
    (context.contextManager.callKibanaApi as jest.Mock).mockResolvedValue({
      status: 200,
      headers: {},
      url: 'http://x',
      body: { output: { ok: true } },
    });

    const result = await definition.handler(context);

    expect(context.contextManager.callKibanaApi).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: INVOKE_STEP_ROUTE_PATH,
        body: expect.objectContaining({ phase: 'run', stepId: 's1', stepType: 'custom.proxied' }),
      })
    );
    expect(result).toEqual({ output: { ok: true } });
  });

  it('surfaces a serialized error from Main as a handler error', async () => {
    const definition = buildStepProxyDefinition({
      id: 'custom.oneShot',
      kind: 'handler',
      configKeys: [],
      hasOnCancel: false,
    });
    if (!isOneShotStepDefinition(definition)) throw new Error('expected a handler definition');
    const context = makeContext();
    (context.contextManager.callKibanaApi as jest.Mock).mockResolvedValue({
      status: 200,
      headers: {},
      url: 'http://x',
      body: { error: { message: 'boom' } },
    });

    const result = await definition.handler(context);
    expect(result.error?.message).toBe('boom');
  });

  it('builds a poll proxy and forwards state/attempt on poll', async () => {
    const definition = buildStepProxyDefinition({
      id: 'custom.poll',
      kind: 'poll',
      configKeys: [],
      hasOnCancel: false,
      hasStart: true,
    });
    if (!isPollStepDefinition(definition)) throw new Error('expected a poll definition');
    const context = makeContext() as unknown as PollHandlerContext;
    (context.contextManager.callKibanaApi as jest.Mock).mockResolvedValue({
      status: 200,
      headers: {},
      url: 'http://x',
      body: { output: { done: true } },
    });
    (context as { state?: unknown }).state = { jobId: 'abc' };
    (context as { attempt?: number }).attempt = 3;

    await definition.poll(context);

    expect(context.contextManager.callKibanaApi).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          phase: 'poll',
          state: { jobId: 'abc' },
          attempt: 3,
        }),
      })
    );
  });

  it('omits onCancel when the index entry reports none', () => {
    const definition = buildStepProxyDefinition({
      id: 'custom.oneShot',
      kind: 'handler',
      configKeys: [],
      hasOnCancel: false,
    });
    expect(definition.onCancel).toBeUndefined();
  });
});

describe('buildTriggerProxyDefinition', () => {
  it('carries the id and requiresConnectorId with a permissive event schema', () => {
    const definition = buildTriggerProxyDefinition({
      id: 'my-namespace.customTrigger',
      requiresConnectorId: true,
    });
    expect(definition.id).toBe('my-namespace.customTrigger');
    expect(definition.requiresConnectorId).toBe(true);
    expect(() => definition.eventSchema.parse({ anything: 'goes' })).not.toThrow();
  });
});
