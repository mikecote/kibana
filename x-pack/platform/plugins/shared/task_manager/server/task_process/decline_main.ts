/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DeclinedRunError } from '../task_running/errors';
import { startTaskProcessServer } from './server';
import type { TaskProcessInit, TaskProcessReady } from './wire';

declare const __KBN_VERSION__: string | undefined;

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: unknown) => process.stderr.write(`${String(message)}\n`),
  error: (message: unknown) => process.stderr.write(`${String(message)}\n`),
};

/**
 * Entry of the task process of a task type that always declines: it serves the task type and answers
 * every run with a declined run, so Kibana runs it. It needs no Elasticsearch connection and none of
 * Core, so the bundle is small. Kibana does not even start it, because it knows the answer; this
 * serves a remote deployment, where every task type of a module is sent to the one remote process.
 */
export const runDecliningTaskProcess = async ({
  taskType,
  reason,
}: {
  taskType: string;
  reason: string;
}) => {
  const init = process.send
    ? await new Promise<Partial<TaskProcessInit>>((resolve) => {
        process.on('message', (message: TaskProcessInit) => {
          if (message?.kind === 'init') resolve(message);
        });
      })
    : {};
  startTaskProcessServer({
    taskDefinitions: new Map([
      [
        taskType,
        {
          createTaskRunner: () => ({
            run: async () => {
              throw new DeclinedRunError(reason);
            },
          }),
        },
      ],
    ]),
    port: Number(process.env.PORT ?? 0),
    logger: logger as never,
    kibanaVersion: init.kibanaVersion ?? process.env.KIBANA_VERSION ?? __KBN_VERSION__ ?? 'unknown',
    authToken: init.authToken || process.env.TASK_PROCESS_TOKEN || undefined,
    onListening: (port) => {
      if (process.send) {
        process.send({ kind: 'ready', port } satisfies TaskProcessReady);
      } else {
        process.stdout.write(`READY ${port}\n`);
      }
    },
  });
};
