/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/*
 * PoC only: lets the watchdog worker persist a quarantine directly to Elasticsearch, without
 * going through the main thread, so the write can land while the main thread is still blocked
 * (and may be killed by a liveness probe before it ever runs JavaScript again).
 */

import { Client } from '@elastic/elasticsearch';
import type { ClientOptions } from '@elastic/elasticsearch';
import { TASK_MANAGER_INDEX } from '../constants';
import type { TaskEventLoopQuarantine } from '../task';
import type { WorkerEsAuth, WorkerEsConnection } from './types';

export type { WorkerEsAuth, WorkerEsConnection } from './types';

export interface QuarantineWriteResult {
  persisted: boolean;
  /** Set when `persisted` is false: a short, loggable reason. */
  error?: string;
}

export interface QuarantineWriter {
  write(taskId: string, quarantine: TaskEventLoopQuarantine): Promise<QuarantineWriteResult>;
}

/** The one call this module needs from the client. Its own interface, not `Client['update']`:
 * that method's typings bind `this` to the full `Client`, which a test double cannot satisfy. */
export interface MinimalEsClient {
  update(
    params: {
      index: string;
      id: string;
      retry_on_conflict: number;
      timeout: string;
      doc: Record<string, unknown>;
    },
    options?: { requestTimeout: number }
  ): Promise<unknown>;
}

const toAuthOption = (auth: WorkerEsAuth): ClientOptions['auth'] => {
  switch (auth.type) {
    case 'basic':
      return { username: auth.username, password: auth.password };
    case 'service_account_token':
      return { bearer: auth.token };
    case 'none':
      return undefined;
  }
};

export const buildClientOptions = (connection: WorkerEsConnection): ClientOptions => ({
  nodes: connection.nodes,
  auth: toAuthOption(connection.auth),
  headers: connection.headers,
  requestTimeout: connection.requestTimeoutMs,
  tls: {
    rejectUnauthorized: connection.tls.rejectUnauthorized,
    ca: connection.tls.ca,
    cert: connection.tls.cert,
    key: connection.tls.key,
    passphrase: connection.tls.passphrase,
  },
});

/**
 * One `update` call per quarantine, id `task:<taskId>`. A 404 (the task doc is already gone, e.g.
 * an ad-hoc task that was removed) is reported as persisted: there is nothing left to quarantine,
 * which is not a failure of this write. Every other error is reported so the caller (the worker's
 * poll loop) can fall back to having the main thread write it once the block ends.
 */
export const createQuarantineWriter = (
  connection: WorkerEsConnection,
  createClient: (options: ClientOptions) => MinimalEsClient = (options) => new Client(options)
): QuarantineWriter => {
  let client: MinimalEsClient | undefined;
  const getClient = () => (client ??= createClient(buildClientOptions(connection)));

  return {
    async write(taskId, quarantine) {
      try {
        await getClient().update(
          {
            index: TASK_MANAGER_INDEX,
            id: `task:${taskId}`,
            retry_on_conflict: 3,
            timeout: '5s',
            doc: {
              task: { status: 'quarantined', quarantine },
              updated_at: new Date().toISOString(),
            },
          },
          { requestTimeout: connection.requestTimeoutMs }
        );
        return { persisted: true };
      } catch (error) {
        const statusCode = (error as { meta?: { statusCode?: number } })?.meta?.statusCode;
        if (statusCode === 404) return { persisted: true };
        return {
          persisted: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};
