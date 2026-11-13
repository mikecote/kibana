/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { encodeMetricResources } from '@kbn/metrics';
import type { ScopeMetrics, MetricResourceSnapshot } from '@kbn/metrics';
import type { ExecutionContextSetup } from '@kbn/core-execution-context-server';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '@kbn/logging';
import type { FakeRequestEnricher } from '@kbn/core-security-server';
import { TASK_PROCESS_SESSION_HEADER } from './session_protocol';
import { isTaskProcessAuthorized } from './task_process_auth';
import type { TaskFeatureFlagDefinitions } from './feature_flag_declarations';
import { assertTaskFeatureFlagValues } from './feature_flag_declarations';
import { TaskProcessAcquireError } from './acquire_error';
import { TaskProcessMetrics } from './run_metrics';
import {
  TASK_PROCESS_PROTOCOL_VERSION,
  TASK_PROCESS_CAPABILITIES,
  TASK_PROCESS_PATHS,
} from './protocol';
import { withTaskProcessTrace } from './task_tracing';
import type { WorkerRunControl } from './worker_run_control';
import type { GetRunCancellation } from './worker_capabilities';
import { AdHocTaskCounter } from '../lib/adhoc_task_counter';
import {
  isDeclinedRunError,
  serializeTaskRunError,
  throwUnrecoverableError,
} from '../task_running/errors';
import { createRunAsContext } from '../task_running/run_as_context';
import type {
  TaskProcessRunRequest,
  TaskProcessRunResponse,
  TaskProcessMetricSnapshot,
} from './wire';
import { DECLINED_STATUS, MAX_TIMER_MS, reviveTaskInstance, serializeRunResult } from './wire';
import {
  buildTaskFakeRequest,
  buildChildRequestEnricher,
} from '../task_running/fake_request_factory';
import { runFlushers, runInRunContext } from './run_context';
import type { RunContext, CancellableTask, TaskRunAsDefinition } from '../task';

/** What the server needs of a task definition: a way to create the run's task. */
export interface TaskProcessTaskDefinition {
  createTaskRunner: (context: RunContext) => CancellableTask;
  runAs?: TaskRunAsDefinition;
}

interface InFlight {
  readonly abortController: AbortController;
  readonly task: { cancel?(): Promise<unknown> };
  readonly finished: Promise<void>;
  readonly adHocTaskCounter: AdHocTaskCounter;
  readonly metrics: TaskProcessMetrics;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    // Decode once at the end: a multi-byte character may be split across chunks.
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
};

/** Rejects an execution or control request with an explicit HTTP status. */
class RefusedRun extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly createdTaskCount?: number,
    public readonly prometheus?: TaskProcessMetricSnapshot
  ) {
    super(message);
  }
}

export const startTaskProcessServer = ({
  taskDefinitions,
  executionContext,
  port,
  host,
  logger,
  kibanaVersion,
  authToken,
  onListening,
  onShutdown,
  flush,
  collectMetrics,
  collectGauges,
  forwardRun,
  getTaskTypes,
  getFeatureFlagDefinitions,
  enrichFakeRequest,
  registerRunCancellation,
  prepareRunControl,
}: {
  taskDefinitions: Map<string, TaskProcessTaskDefinition>;
  executionContext?: Pick<ExecutionContextSetup, 'withContext'>;
  port: number;
  /**
   * The address to listen on. A process Kibana forked listens on `127.0.0.1` only: the run request
   * carries credentials. A remote process leaves it unset to be reachable from other hosts.
   */
  host?: string;
  logger: Logger;
  /** The Kibana version this process was built for; runs from another version are refused. */
  kibanaVersion: string;
  /** Bearer token required on versioned business routes; health stays open. */
  authToken?: string;
  /** Called with the port once listening, which matters when the OS picked it. */
  onListening?: (port: number) => void;
  /** Called once the in-flight runs have finished and before the process exits. */
  onShutdown?: () => Promise<void>;
  /**
   * Finishes what the run left to do, such as shipping its analytics events, before the response
   * is sent: Kibana does nothing with a run besides rescheduling it. Bounded by the caller.
   */
  flush?: () => Promise<boolean | void>;
  collectMetrics?: () => Promise<ScopeMetrics[]>;
  collectGauges?: (owner?: string) => Promise<MetricResourceSnapshot[]>;
  /** A remote supervisor forwards each run to an isolated execution process. */
  forwardRun?: (
    request: TaskProcessRunRequest,
    context: Pick<RunContext, 'signal' | 'setCustomTaskRunEventFields'>
  ) => CancellableTask;
  getTaskTypes?: () => string[];
  getFeatureFlagDefinitions?: (taskType: string) => TaskFeatureFlagDefinitions | undefined;
  enrichFakeRequest?: FakeRequestEnricher;
  registerRunCancellation?: (getCancellation: GetRunCancellation) => void;
  prepareRunControl?: (
    executionUuid: string,
    counter: AdHocTaskCounter,
    signal: AbortSignal,
    sessionId?: string
  ) => Promise<WorkerRunControl>;
}) => {
  const inFlight = new Map<string, InFlight>();
  let draining = false;
  // Concurrent remote cancellations retain separate telemetry until consumed or their grace expires.
  const completedMetrics = new Map<
    string,
    {
      prometheus?: TaskProcessMetricSnapshot;
      timer: NodeJS.Timeout;
    }
  >();
  const takeCompletedMetrics = (executionUuid: string) => {
    const completed = completedMetrics.get(executionUuid);
    if (completed) {
      clearTimeout(completed.timer);
      completedMetrics.delete(executionUuid);
    }
    return completed;
  };

  const handleRun = async (
    body: TaskProcessRunRequest,
    sessionId?: string
  ): Promise<TaskProcessRunResponse | undefined> => {
    if (body.protocolVersion !== TASK_PROCESS_PROTOCOL_VERSION) {
      throw new RefusedRun(409, 'Task worker dispatch protocol is incompatible');
    }
    const definition = taskDefinitions.get(body.taskType);
    if (!definition && !forwardRun) return undefined;
    if (body.snapshot && !forwardRun) {
      throw new RefusedRun(409, 'Dispatch snapshots require a task worker supervisor');
    }
    if (getFeatureFlagDefinitions) {
      const declared = getFeatureFlagDefinitions(body.taskType);
      if (!declared) {
        throw new TaskProcessAcquireError(
          'incompatible',
          'Missing native feature flag declarations; rebuild the bundle'
        );
      }
      assertTaskFeatureFlagValues(body.featureFlags, declared);
      if (body.snapshot) {
        assertTaskFeatureFlagValues(body.snapshot.featureFlags, declared);
        if (
          Object.keys(declared).some(
            (name) => body.featureFlags?.[name] !== body.snapshot?.featureFlags?.[name]
          )
        ) {
          throw new TaskProcessAcquireError(
            'incompatible',
            'Run and dispatch snapshot feature flags disagree'
          );
        }
      }
    }
    if (draining) throw new RefusedRun(503, 'task process is shutting down');
    if (!forwardRun && inFlight.size) throw new RefusedRun(503, 'task process is busy');
    if (inFlight.has(body.executionUuid)) throw new RefusedRun(409, 'execution is already running');
    if (body.kibanaVersion && body.kibanaVersion !== kibanaVersion) {
      throw new RefusedRun(
        409,
        `task process was built for Kibana ${kibanaVersion}, run is from ${body.kibanaVersion}`
      );
    }

    const abortController = new AbortController();
    // Kibana stops waiting at the task's deadline; stop the work then too.
    const deadlineMs = body.deadline ? new Date(body.deadline).getTime() - Date.now() : undefined;
    const deadlineTimer =
      deadlineMs !== undefined && Number.isFinite(deadlineMs)
        ? setTimeout(() => abortController.abort(), Math.min(Math.max(deadlineMs, 0), MAX_TIMER_MS))
        : undefined;
    const customFields: Record<string, unknown>[] = [];
    const fakeRequest = buildTaskFakeRequest({
      apiKey: body.apiKey,
      spaceId: body.spaceId,
      uiamApiKeyExternal: body.uiamApiKeyExternal,
      userProfileId: body.userProfileId,
      userName: body.userName,
      enrichFakeRequest,
    });
    const enrichRequest = buildChildRequestEnricher({
      userProfileId: body.userProfileId,
      userName: body.userName,
      enrichFakeRequest,
    });

    let task: CancellableTask | undefined;
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const adHocTaskCounter = new AdHocTaskCounter();
    const metrics = new TaskProcessMetrics(collectMetrics);
    inFlight.set(body.executionUuid, {
      adHocTaskCounter,
      metrics,
      abortController,
      task: { cancel: async () => task?.cancel?.() },
      finished,
    });
    const flushers: Array<() => Promise<void>> = [];
    let flushed = true;
    let runControl: WorkerRunControl | undefined;
    let cleanupSucceeded = true;
    const cleanupTask = async (): Promise<void> => {
      try {
        await task?.cleanup?.();
      } catch (cleanupError) {
        cleanupSucceeded = false;
        logger.warn(`Cleanup of ${body.taskType} failed: ${(cleanupError as Error).message}`);
      }
    };
    const flushEffects = async (): Promise<void> => {
      try {
        const results = await Promise.all([runFlushers(flushers, logger), flush?.()]);
        flushed = results.every((result) => result !== false);
      } catch (flushError) {
        flushed = false;
        logger.warn(`Flushing after ${body.taskType} failed: ${(flushError as Error).message}`);
      }
    };
    try {
      runControl = await prepareRunControl?.(
        body.executionUuid,
        adHocTaskCounter,
        abortController.signal,
        sessionId
      );
      const { value, error } = await runInRunContext(
        async () => {
          const runTask = async () => {
            try {
              if (forwardRun) {
                task = forwardRun(body, {
                  signal: abortController.signal,
                  setCustomTaskRunEventFields: (fields) => customFields.push(fields),
                });
                return await task.run();
              }
              if (!definition) throw new Error(`Unregistered task type ${body.taskType}`);
              if (
                body.runAs &&
                !definition.runAs?.workloadTypes.includes(body.runAs.workloadType)
              ) {
                throwUnrecoverableError(
                  new Error(
                    `Task type ${body.taskType} does not support workload ${body.runAs.workloadType}`
                  )
                );
              }
              task = definition.createTaskRunner({
                taskInstance: reviveTaskInstance(body.taskInstance),
                ...(body.runAs && definition.runAs
                  ? { runAs: createRunAsContext(definition.runAs, body.runAs) }
                  : { fakeRequest, enrichRequest }),
                signal: abortController.signal,
                executionUuid: body.executionUuid,
                setCustomTaskRunEventFields: (fields: Record<string, unknown>) =>
                  customFields.push(fields),
              });
              return await task.run();
            } finally {
              await cleanupTask();
            }
          };
          try {
            if (forwardRun) return await runTask();
            if (!executionContext)
              throw new Error('Task execution requires native Core execution context');
            return await withTaskProcessTrace(body, runTask, executionContext);
          } finally {
            await flushEffects();
          }
        },
        {
          featureFlags: body.featureFlags,
          flushers,
          executionId:
            typeof body.taskInstance.id === 'string'
              ? `${body.taskInstance.id}::${body.executionUuid}`
              : undefined,
          adHocTaskCounter,
          prometheusMetrics: metrics,
          withCoordinatorCapability: runControl?.withCoordinatorCapability,
          getCurrentTasksInPool:
            runControl?.getCurrentTasksInPool ??
            (async () => {
              throw new Error('Task dispatch has no control session');
            }),
        }
      );
      const prometheus = await metrics.collect(true).catch((metricError: Error) => {
        flushed = false;
        logger.warn(`Native metric collection for ${body.taskType} failed: ${metricError.message}`);
        return metrics.snapshot();
      });
      if (error !== undefined) {
        if (isDeclinedRunError(error)) {
          throw new RefusedRun(
            DECLINED_STATUS,
            (error as Error).message,
            adHocTaskCounter.count,
            prometheus
          );
        }
        return {
          kind: 'thrown',
          prometheus,
          createdTaskCount: adHocTaskCounter.count,
          error: serializeTaskRunError(error),
          customTaskRunEventFields: customFields.at(-1),
        } as TaskProcessRunResponse;
      }
      const response = {
        kind: 'result',
        prometheus,
        createdTaskCount: adHocTaskCounter.count,
        result: serializeRunResult(value as never),
        customTaskRunEventFields: customFields.at(-1),
        reusable: cleanupSucceeded && flushed && !abortController.signal.aborted,
      } as TaskProcessRunResponse;
      return response;
    } finally {
      await runControl?.dispose();
      if (prepareRunControl && abortController.signal.aborted) {
        takeCompletedMetrics(body.executionUuid);
        const timer = setTimeout(
          () => completedMetrics.delete(body.executionUuid),
          Math.min(body.cancelGracePeriodMs ?? 5000, MAX_TIMER_MS)
        );
        timer.unref();
        completedMetrics.set(body.executionUuid, { prometheus: metrics.snapshot(), timer });
      }
      clearTimeout(deadlineTimer);
      inFlight.delete(body.executionUuid);
      finish();
    }
  };

  const getCancellation: GetRunCancellation = (executionUuid) => {
    const entry = inFlight.get(executionUuid);
    if (!entry) return undefined;
    return async () => {
      entry.abortController.abort();
      await entry.task.cancel?.();
      await entry.finished;
      return {
        prometheus: entry.metrics.snapshot(),
        createdTaskCount: entry.adHocTaskCounter.count,
      };
    };
  };
  registerRunCancellation?.(getCancellation);

  const server = createServer(async (req, res) => {
    try {
      if (
        req.method === 'GET' &&
        (req.url === '/health' || req.url === TASK_PROCESS_PATHS.health)
      ) {
        sendJson(res, 200, {
          protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
          capabilities: TASK_PROCESS_CAPABILITIES,
          inFlight: inFlight.size,
          rss: process.memoryUsage().rss,
          taskTypes: getTaskTypes?.() ?? [...taskDefinitions.keys()],
        });
        return;
      }

      const isAuthorized = !authToken || isTaskProcessAuthorized(req, authToken);
      if (
        (req.method === 'POST' && req.url === TASK_PROCESS_PATHS.run) ||
        (req.method === 'GET' &&
          (req.url === TASK_PROCESS_PATHS.metrics ||
            req.url?.startsWith(`${TASK_PROCESS_PATHS.metrics}?`) ||
            req.url?.startsWith(`${TASK_PROCESS_PATHS.metrics}/`)))
      ) {
        if (!isAuthorized) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
      }

      if (
        req.method === 'GET' &&
        (req.url === TASK_PROCESS_PATHS.metrics ||
          req.url?.startsWith(`${TASK_PROCESS_PATHS.metrics}?`))
      ) {
        const owner = new URL(req.url, 'http://task-worker').searchParams.get('owner') ?? undefined;
        if (owner !== undefined && (!owner.length || owner.length > 128)) {
          throw new RefusedRun(400, 'Invalid native metric owner');
        }
        sendJson(res, 200, {
          encoded: encodeMetricResources(collectGauges ? await collectGauges(owner) : []),
        });
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith(`${TASK_PROCESS_PATHS.metrics}/`)) {
        const executionUuid = req.url.slice(TASK_PROCESS_PATHS.metrics.length + 1);
        const entry = inFlight.get(executionUuid);
        const completed = entry ? undefined : takeCompletedMetrics(executionUuid);
        const prometheus = await entry?.metrics.collect().catch((error: Error) => {
          logger.warn(`Native metric progress collection failed: ${error.message}`);
          return entry.metrics.snapshot();
        });
        sendJson(
          res,
          entry || completed ? 200 : 404,
          entry || completed
            ? { prometheus: prometheus ?? completed?.prometheus }
            : { error: 'no such in-flight run' }
        );
        return;
      }

      if (req.method === 'POST' && req.url === TASK_PROCESS_PATHS.run) {
        const body = JSON.parse(await readBody(req)) as TaskProcessRunRequest;
        // Kibana hung up (it timed out or was cancelled): don't keep running for nobody.
        res.on('close', () => {
          if (!res.writableEnded) inFlight.get(body.executionUuid)?.abortController.abort();
        });
        const sessionHeader = req.headers[TASK_PROCESS_SESSION_HEADER];
        const response = await handleRun(
          body,
          typeof sessionHeader === 'string' ? sessionHeader : undefined
        );
        if (!response) {
          sendJson(res, 404, { error: `unregistered task type '${body.taskType}'` });
          return;
        }
        sendJson(res, 200, response);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof TaskProcessAcquireError) {
        sendJson(res, error.reason === 'unavailable' ? 503 : DECLINED_STATUS, {
          kind: error.reason === 'unavailable' ? 'unavailable' : 'incompatible',
          reason: error.message,
        });
        return;
      }
      if (error instanceof RefusedRun) {
        sendJson(
          res,
          error.status,
          error.status === DECLINED_STATUS
            ? {
                kind: 'declined',
                reason: error.message,
                createdTaskCount: error.createdTaskCount,
                prometheus: error.prometheus,
              }
            : { error: error.message }
        );
        return;
      }
      sendJson(res, 500, { error: (error as Error).message });
    }
  });

  // One failing background promise (a late callback after its run ended, say) must not take down
  // every run the process is serving.
  const onUnhandledRejection = (reason: Error) => {
    logger.error(`unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`);
  };
  process.on('unhandledRejection', onUnhandledRejection);

  // Stop taking runs, let in-flight ones finish (they stop at their own deadline), then exit.
  const shutdown = () => {
    draining = true;
    server.close();
    const waiter = setInterval(() => {
      if (inFlight.size === 0) {
        clearInterval(waiter);
        (onShutdown?.() ?? Promise.resolve())
          .catch((error) => logger.warn(`Shutdown failed: ${(error as Error).message}`))
          .finally(() => process.exit(0));
      }
    }, 100);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('close', () => {
    for (const { timer } of completedMetrics.values()) clearTimeout(timer);
    completedMetrics.clear();
    process.removeListener('unhandledRejection', onUnhandledRejection);
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  });

  const onListen = () => {
    const address = server.address();
    onListening?.(typeof address === 'object' && address ? address.port : port);
  };
  if (host) server.listen(port, host, onListen);
  else server.listen(port, onListen);
  return server;
};
