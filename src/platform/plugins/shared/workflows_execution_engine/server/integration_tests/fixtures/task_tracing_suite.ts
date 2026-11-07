/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { join } from 'node:path';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { lazySchema, z } from '@kbn/zod/v4';
import { createTaskTraceCollector } from './task_trace_collector';
import { createTraceInstrumentation, createTraceTlsSources } from './task_trace_instrumentation';
import {
  startWorkflowProcessHarness,
  WORKFLOW_PROCESS_TEST_MODES,
} from '../workflow_process_harness';

const stateSchema = lazySchema(() =>
  z.object({
    apmTraceparent: z.string().nullable(),
    otelTraceId: z.string().nullable(),
    scheduledTraceparent: z.string(),
    executionLabels: z.object({ name: z.string().optional(), id: z.string().optional() }),
  })
);
const outputSchema = lazySchema(() =>
  z.union([z.object({ output: stateSchema }).transform(({ output }) => output), stateSchema])
);

/** Registers the shared native tracing proof for HTTP or HTTPS transports. */
export const defineNativeTaskTracingTests = (tls: boolean): void => {
  for (const backend of ['apm', 'otel'] as const) {
    describe.each(WORKFLOW_PROCESS_TEST_MODES)(
      `Native ${backend}${tls ? ' TLS' : ''} task tracing in $mode (reuse: $reuse)`,
      ({ mode, reuse }) => {
        let harness: Awaited<ReturnType<typeof startWorkflowProcessHarness>>;
        let collector: Awaited<ReturnType<typeof createTaskTraceCollector>>;
        const logging = loggingSystemMock.create();
        const executionContextConfig = { enabled: true };
        let instrumentation: ReturnType<typeof createTraceInstrumentation>;
        let specificInstrumentation: ReturnType<typeof createTraceInstrumentation>;
        beforeAll(async () => {
          const sources = tls ? createTraceTlsSources() : undefined;
          try {
            collector = await createTaskTraceCollector(
              sources && { ...sources.server, requestCert: backend === 'otel' }
            );
            instrumentation = createTraceInstrumentation(backend, collector.url, sources?.paths);
            specificInstrumentation = createTraceInstrumentation(
              backend,
              collector.url,
              sources?.paths,
              true
            );
            harness = await startWorkflowProcessHarness({
              mode,
              reuse,
              logger: logging.get(),
              executionContext: executionContextConfig,
              instrumentation,
              additionalContributions: {
                'workflow-steps': [join(__dirname, 'task_tracing_contribution.ts')],
              },
              workflows: Object.fromEntries(
                ['first', 'second', 'disabled'].map((id) => [
                  id,
                  {
                    steps: [
                      {
                        name: 'trace',
                        type: 'test.task_tracing.native',
                        with: { taskId: `trace-${id}` },
                      },
                    ],
                  },
                ])
              ),
            });
          } finally {
            sources?.cleanup();
          }
        });
        afterAll(async () => {
          try {
            await harness?.stop();
          } finally {
            await collector?.stop();
          }
        });
        it('exports completed native task spans and preserves dispatch and scheduling parents across reused executions', async () => {
          const failure = jest.fn();
          const instances: string[] = [];
          for (const [index, id] of ['first', 'second', 'disabled'].entries()) {
            executionContextConfig.enabled = index < 2;
            if (tls && index === 2) Object.assign(instrumentation, specificInstrumentation);
            const traceId = String(index + 1).repeat(32);
            const parentId = String(index + 3).repeat(16);
            const traceparent = `00-${traceId}-${parentId}-01`;
            await harness
              .runTask(
                'workflow:scheduled',
                {
                  id: `workflow:${id}:scheduled`,
                  params: { workflowId: id, spaceId: 'default', triggerType: 'scheduled' },
                },
                failure,
                undefined,
                {
                  apmTraceparent: traceparent,
                  carrier: { traceparent },
                }
              )
              .catch((error: Error) => {
                throw new Error(
                  `${error.message}\n${JSON.stringify(loggingSystemMock.collect(logging))}`,
                  { cause: error }
                );
              });
            const [execution] = await harness.executionsOf(id);
            expect(execution.status).toBe('completed');
            const [step] = await harness.stepsOf(execution.id);
            const state = outputSchema.parse(step.output);
            expect(state.executionLabels).toEqual(
              executionContextConfig.enabled
                ? {
                    name: 'run workflow:scheduled',
                    id: `workflow:${id}:scheduled`,
                  }
                : {}
            );
            if (backend === 'apm') {
              const transaction = collector.apmTransactions.find(
                (item) => item.trace_id === traceId && item.type === 'task-run'
              );
              expect(transaction).toEqual(
                expect.objectContaining({ name: 'workflow:scheduled', parent_id: parentId })
              );
              if (!transaction) throw new Error('Native APM task transaction was not exported');
              expect(state.apmTraceparent).toBe(`00-${traceId}-${transaction.id}-01`);
              const [, scheduledTraceId, scheduledParentId] = state.scheduledTraceparent.split('-');
              expect(scheduledTraceId).toBe(traceId);
              let currentId = scheduledParentId;
              const seen = new Set<string>();
              while (currentId !== transaction.id) {
                if (seen.has(currentId)) throw new Error('Scheduled trace has a parent cycle');
                seen.add(currentId);
                const span = collector.apmSpans.find((item) => item.id === currentId);
                expect(span?.trace_id).toBe(traceId);
                if (!span?.parent_id)
                  throw new Error(
                    'Scheduled trace does not descend from the native task transaction'
                  );
                currentId = span.parent_id;
              }
            } else {
              expect(state.otelTraceId).toBe(traceId);
              expect(state.apmTraceparent).toBeNull();
              expect(state.scheduledTraceparent).toBe('');
              const exported = collector.otelSpans.find(
                ({ span }) => span.traceId === traceId && span.name === 'task-manager-run'
              );
              expect(exported?.span.parentSpanId).toBe(parentId);
              expect(
                exported?.resource.attributes.find(({ key }) => key === 'parity.native')?.value
                  .stringValue
              ).toBe('from-main');
              const instance = exported?.resource.attributes.find(
                ({ key }) => key === 'service.instance.id'
              )?.value.stringValue;
              expect(instance).toEqual(expect.any(String));
              if (!instance) throw new Error('Native OTel resource has no process instance id');
              instances.push(instance);
            }
          }
          if (backend === 'otel') {
            expect(instances[0] === instances[1]).toBe(reuse);
            expect(instances[2]).not.toBe(instances[1]);
            expect(new Set(instances).size).toBe(reuse ? 2 : 3);
          }
          expect(harness.getWorkerStats().spawned).toBe(reuse ? 2 : 3);
          if (tls && backend === 'otel')
            expect(collector.authenticatedExports).toBeGreaterThanOrEqual(3);
          expect(failure).not.toHaveBeenCalled();
          expect(harness.kibanaRequests).toEqual([]);
        });
      }
    );
  }
};
