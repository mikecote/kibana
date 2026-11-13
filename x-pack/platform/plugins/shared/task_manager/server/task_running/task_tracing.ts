/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ExecutionContextSetup } from '@kbn/core-execution-context-server';
import { withSpan } from '@kbn/apm-utils';
import apm from 'elastic-apm-node';
import type { Context } from '@opentelemetry/api';
import { context, propagation } from '@opentelemetry/api';
import { withActiveSpan } from '@kbn/tracing-utils';
import type { ConcreteTaskInstance } from '../task';
import { getExecutionContextRunner } from '../lib/execution_context';

export const TASK_MANAGER_RUN_TRANSACTION_TYPE = 'task-run';

export interface TaskRunTrace {
  apmTraceparent?: string;
  carrier: Record<string, string>;
}

/** Captures the active native trace context once, preserving it through remote supervisors. */
export const captureTaskRunTrace = (): TaskRunTrace | undefined => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  if (!apm.currentTraceparent && Object.keys(carrier).length === 0) return undefined;
  return { ...(apm.currentTraceparent ? { apmTraceparent: apm.currentTraceparent } : {}), carrier };
};

/** Starts the native task transaction used by Main and execution workers. */
export const startTaskRunTransaction = (
  taskType: string,
  parent?: string
): ReturnType<typeof apm.startTransaction> =>
  apm.startTransaction(taskType, TASK_MANAGER_RUN_TRANSACTION_TYPE, { childOf: parent });

/** Runs task work within the native task span and its explicit dispatch context when present. */
export const withTaskRunSpan = <T>(taskType: string, run: () => T, parent?: Context): T =>
  withActiveSpan(
    'task-manager-run',
    {
      attributes: {
        'transaction.type': TASK_MANAGER_RUN_TRANSACTION_TYPE,
        'kibana.task.type': taskType,
      },
      root: parent === undefined,
    },
    parent ?? context.active(),
    run
  );

/** Binds native task labels and the business span identically in Main and execution workers. */
export const runTaskWithExecutionContext = <T>(
  executionContext: Pick<ExecutionContextSetup, 'withContext'>,
  task: Pick<ConcreteTaskInstance, 'id' | 'taskType'>,
  run: () => Promise<T>
): Promise<T> =>
  getExecutionContextRunner(executionContext, {
    name: `run ${task.taskType}`,
    id: task.id,
    description: 'run task',
  }).run(() => withSpan({ name: 'run', type: 'task manager' }, run));
