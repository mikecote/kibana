/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TASK_MANAGER_INDEX } from '../constants';
import {
  buildClientOptions,
  createQuarantineWriter,
  type WorkerEsConnection,
} from './quarantine_writer';

const connection: WorkerEsConnection = {
  nodes: ['http://localhost:9200'],
  auth: { type: 'basic', username: 'kibana', password: 'changeme' },
  tls: { rejectUnauthorized: true },
  headers: { 'x-custom': 'value' },
  requestTimeoutMs: 5000,
};

const quarantine = {
  at: '2026-01-01T00:00:00.000Z',
  reason: 'multiple-contexts',
  blockedMs: 5234,
  executionUuid: 'execution-1',
  persistedBy: 'worker' as const,
};

describe('buildClientOptions', () => {
  it('maps basic auth', () => {
    expect(buildClientOptions(connection).auth).toEqual({
      username: 'kibana',
      password: 'changeme',
    });
  });

  it('maps a service account token to bearer auth', () => {
    const options = buildClientOptions({
      ...connection,
      auth: { type: 'service_account_token', token: 'token-value' },
    });
    expect(options.auth).toEqual({ bearer: 'token-value' });
  });

  it('maps no auth to undefined', () => {
    const options = buildClientOptions({ ...connection, auth: { type: 'none' } });
    expect(options.auth).toBeUndefined();
  });

  it('carries nodes, headers, timeout and tls through', () => {
    const options = buildClientOptions(connection);
    expect(options.nodes).toEqual(connection.nodes);
    expect(options.headers).toEqual(connection.headers);
    expect(options.requestTimeout).toBe(connection.requestTimeoutMs);
    expect(options.tls).toMatchObject({ rejectUnauthorized: true });
  });
});

describe('createQuarantineWriter', () => {
  it('writes the quarantine as a partial update on the task document', async () => {
    const update = jest.fn().mockResolvedValue({});
    const writer = createQuarantineWriter(connection, () => ({ update }));

    const result = await writer.write('task-1', quarantine);

    expect(result).toEqual({ persisted: true });
    expect(update).toHaveBeenCalledWith(
      {
        index: TASK_MANAGER_INDEX,
        id: 'task:task-1',
        retry_on_conflict: 3,
        timeout: '5s',
        doc: {
          task: { status: 'quarantined', quarantine },
          updated_at: expect.any(String),
        },
      },
      { requestTimeout: connection.requestTimeoutMs }
    );
  });

  it('only builds the client once across writes', async () => {
    const update = jest.fn().mockResolvedValue({});
    const createClient = jest.fn().mockReturnValue({ update });
    const writer = createQuarantineWriter(connection, createClient);

    await writer.write('task-1', quarantine);
    await writer.write('task-2', quarantine);

    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('treats a 404 as persisted: the task is already gone', async () => {
    const update = jest.fn().mockRejectedValue({ meta: { statusCode: 404 } });
    const writer = createQuarantineWriter(connection, () => ({ update }));

    const result = await writer.write('task-1', quarantine);

    expect(result).toEqual({ persisted: true });
  });

  it('reports other errors as not persisted', async () => {
    const update = jest.fn().mockRejectedValue(new Error('timeout'));
    const writer = createQuarantineWriter(connection, () => ({ update }));

    const result = await writer.write('task-1', quarantine);

    expect(result).toEqual({ persisted: false, error: 'timeout' });
  });

  it('reports a non-Error rejection as not persisted', async () => {
    const update = jest.fn().mockRejectedValue('boom');
    const writer = createQuarantineWriter(connection, () => ({ update }));

    const result = await writer.write('task-1', quarantine);

    expect(result).toEqual({ persisted: false, error: 'boom' });
  });
});
