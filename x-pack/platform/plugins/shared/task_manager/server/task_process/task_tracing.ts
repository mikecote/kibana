/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ExecutionContextSetup } from '@kbn/core-execution-context-server';
import { ROOT_CONTEXT, propagation } from '@opentelemetry/api';
import { reviveTaskInstance } from './wire';
import {
  startTaskRunTransaction,
  withTaskRunSpan,
  runTaskWithExecutionContext,
} from '../task_running/task_tracing';
import type { TaskProcessRunRequest } from './wire';

/** Executes worker task code in the dispatch trace with the same native transaction as Main. */
export const withTaskProcessTrace = <T>(
  body: TaskProcessRunRequest,
  run: () => Promise<T>,
  executionContext: Pick<ExecutionContextSetup, 'withContext'>
): Promise<T> => {
  const parent = body.tracing ? propagation.extract(ROOT_CONTEXT, body.tracing.carrier) : undefined;
  const savedParent =
    typeof body.taskInstance.traceparent === 'string' ? body.taskInstance.traceparent : undefined;
  return withTaskRunSpan(
    body.taskType,
    async () => {
      const transaction = startTaskRunTransaction(
        body.taskType,
        body.tracing?.apmTraceparent ?? savedParent
      );
      try {
        const result = await runTaskWithExecutionContext(
          executionContext,
          reviveTaskInstance(body.taskInstance),
          run
        );
        transaction?.end('success');
        return result;
      } catch (error) {
        transaction?.end('failure');
        throw error;
      }
    },
    parent
  );
};
