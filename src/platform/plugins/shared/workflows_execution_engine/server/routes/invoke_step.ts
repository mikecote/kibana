/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { schema } from '@kbn/config-schema';
import type { CoreStart, IRouter, KibanaRequest, Logger } from '@kbn/core/server';
import {
  isOneShotStepDefinition,
  isPollStepDefinition,
  type StepHandlerContext,
  type WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';
import { callKibanaApi } from '../lib/call_kibana_api';
import type { WorkflowCoreStart } from '../workflow_core_services';

export const INVOKE_STEP_ROUTE_PATH = '/internal/workflows_execution_engine/steps/_invoke';

const invokeStepBodySchema = schema.object({
  phase: schema.oneOf([
    schema.literal('run'),
    schema.literal('start'),
    schema.literal('poll'),
    schema.literal('cancel'),
  ]),
  stepId: schema.string(),
  stepType: schema.string(),
  spaceId: schema.maybe(schema.string()),
  input: schema.any(),
  rawInput: schema.maybe(schema.any()),
  config: schema.maybe(schema.recordOf(schema.string(), schema.any())),
  /** Durable poll state from the previous `start`/`poll` call, and its 0-based attempt index. */
  state: schema.maybe(schema.any()),
  attempt: schema.maybe(schema.number()),
  /**
   * `StepExecutionRuntime.contextManager.getContext()`/`getExecutionMetadata()`, already
   * evaluated by the worker before this call: this route replays them rather than
   * re-deriving live workflow state Main does not hold. See the "context" limitation on
   * {@link buildMainStepHandlerContext}.
   */
  contextSnapshot: schema.maybe(schema.any()),
  executionMetadata: schema.maybe(schema.any()),
});

export type InvokeStepBody = typeof invokeStepBodySchema.type;

/** What the route answers with: `output` means done, `error` means failed, otherwise continuing. */
export interface InvokeStepResponseBody {
  output?: unknown;
  error?: { message: string; name?: string };
  /** Present on a poll continuation (`start`/`poll` returning `{ state }` rather than finishing). */
  state?: unknown;
  nextPollDelayMs?: number;
}

const serializeError = (error: Error): { message: string; name?: string } => ({
  message: error.message,
  name: error.name,
});

/**
 * Builds the `StepHandlerContext` a real plugin step handler expects, from a worker's request
 * instead of a live `StepExecutionRuntime`. Credentials, the Elasticsearch client and
 * `callKibanaApi` are all real (scoped to the incoming request, which carries the run's own
 * Authorization header via Core's self client). `getContext()`/`getExecutionMetadata()` replay
 * the snapshot the worker sent rather than reading live state Main does not hold.
 *
 * Known v1 limitation: `renderInputTemplate`/`createTemplateRenderer` return their input
 * unchanged. `input`/`config` are already template-rendered by the worker before it calls out
 * (as they are for any step), so this only matters for a handler that renders additional
 * ad-hoc templates mid-execution; none of the built-in step kinds this route serves do that
 * today, but a future contribution that needs it should get a real renderer here instead.
 */
export const buildMainStepHandlerContext = ({
  request,
  coreStart,
  spaceId,
  stepId,
  stepType,
  input,
  rawInput,
  config,
  contextSnapshot,
  executionMetadata,
  logger,
}: {
  request: KibanaRequest;
  coreStart: CoreStart;
  spaceId?: string;
  stepId: string;
  stepType: string;
  input: unknown;
  rawInput: unknown;
  config: Record<string, unknown>;
  contextSnapshot: unknown;
  executionMetadata: unknown;
  logger: Logger;
}): StepHandlerContext => {
  const abortController = new AbortController();
  const subscription = request.events.aborted$.subscribe(() => abortController.abort());
  request.events.completed$.subscribe(() => subscription.unsubscribe());
  return {
    input,
    rawInput: rawInput ?? {},
    config: config ?? {},
    contextManager: {
      getContext: () => contextSnapshot as never,
      getExecutionMetadata: () => executionMetadata as never,
      getScopedEsClient: () => coreStart.elasticsearch.client.asScoped(request).asCurrentUser,
      renderInputTemplate: (value) => value,
      createTemplateRenderer: () => (value) => value,
      getFakeRequest: () => request,
      callKibanaApi: (params) =>
        callKibanaApi(
          { fakeRequest: request, coreStart: coreStart as WorkflowCoreStart, spaceId },
          { ...params, signal: abortController.signal }
        ),
    },
    logger: {
      debug: (message, meta) => logger.debug(message, meta),
      info: (message, meta) => logger.info(message, meta),
      warn: (message, meta) => logger.warn(message, meta),
      error: (message, error) => logger.error(message, { error }),
    },
    abortSignal: abortController.signal,
    stepId,
    stepType,
  };
};

/**
 * Internal route a thin worker (one with no `workflow-steps` contributions of its own) calls to
 * run a plugin-registered step here instead: the engine-to-engine seam of the Option B thin
 * worker. Called through the run's own Core self client (`ContextManager.callKibanaApi`), so the
 * request already carries the execution's own credentials; access is further restricted to
 * Kibana's internal-origin loopback (`access: 'internal'`), matching the `kibana.request` step
 * and `callKibanaApi`'s own security model. Not for use outside the engine.
 */
export function registerInvokeStepRoute(
  router: IRouter,
  getStartServices: () => Promise<
    [CoreStart, { workflowsExtensions: WorkflowsExtensionsServerPluginStart }]
  >,
  logger: Logger
): void {
  router.post(
    {
      path: INVOKE_STEP_ROUTE_PATH,
      options: { access: 'internal' },
      security: {
        authz: {
          enabled: false,
          reason:
            'Engine-to-engine step invocation from a thin task worker. The request carries the ' +
            "run's own API key (via Core's self client) and is restricted to internal origin, " +
            'the same model as callKibanaApi/kibana.request.',
        },
      },
      validate: { body: invokeStepBodySchema },
    },
    async (_context, request, response) => {
      const [coreStart, { workflowsExtensions }] = await getStartServices();
      const body = request.body as InvokeStepBody;
      const definition = workflowsExtensions.getStepDefinition(body.stepType);
      if (!definition) {
        return response.notFound({
          body: { message: `Step type "${body.stepType}" is not registered in this Kibana` },
        });
      }

      const context = buildMainStepHandlerContext({
        request,
        coreStart,
        spaceId: body.spaceId,
        stepId: body.stepId,
        stepType: body.stepType,
        input: body.input,
        rawInput: body.rawInput,
        config: (body.config ?? {}) as Record<string, unknown>,
        contextSnapshot: body.contextSnapshot,
        executionMetadata: body.executionMetadata,
        logger,
      });

      try {
        if (body.phase === 'cancel') {
          await definition.onCancel?.(context);
          return response.ok({ body: {} satisfies InvokeStepResponseBody });
        }

        if (body.phase === 'run') {
          if (!isOneShotStepDefinition(definition)) {
            return response.badRequest({
              body: { message: `Step type "${body.stepType}" is not a one-shot step` },
            });
          }
          const result = await definition.handler(context);
          const out: InvokeStepResponseBody = { output: result.output };
          if (result.error) out.error = serializeError(result.error);
          return response.ok({ body: out });
        }

        if (!isPollStepDefinition(definition)) {
          return response.badRequest({
            body: { message: `Step type "${body.stepType}" is not a poll step` },
          });
        }
        const pollContext = { ...context, state: body.state, attempt: body.attempt ?? 0 };
        const result =
          body.phase === 'start'
            ? definition.start
              ? await definition.start(pollContext)
              : undefined
            : await definition.poll(pollContext);

        if (!result) return response.ok({ body: {} satisfies InvokeStepResponseBody });
        if (result.error) return response.ok({ body: { error: serializeError(result.error) } });
        if (result.output !== undefined) {
          return response.ok({ body: { output: result.output } });
        }
        const continuing = result as Exclude<typeof result, { output: unknown }>;
        return response.ok({
          body: { state: continuing.state, nextPollDelayMs: continuing.nextPollDelayMs },
        });
      } catch (error) {
        logger.error(`Step invocation failed for "${body.stepType}" (${body.phase})`, { error });
        return response.ok({ body: { error: serializeError(error as Error) } });
      }
    }
  );
}
