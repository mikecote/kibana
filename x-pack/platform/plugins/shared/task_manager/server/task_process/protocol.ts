/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { METRIC_SERIALIZATION_VERSION } from '@kbn/metrics';
import { schema } from '@kbn/config-schema';
import { TaskProcessAcquireError } from './acquire_error';

export const TASK_PROCESS_PROTOCOL_VERSION = 3;
export const TASK_PROCESS_CAPABILITIES = [
  'session-control',
  'shared-init-settings',
  'live-init-authority',
  'placed-coordinator-capabilities',
  'native-task-scheduling',
  'ordered-task-middleware',
  'native-tracing-with-portable-tls',
  'core-execution-context',
  'created-task-counts',
  'native-prometheus-handoff',
  'live-worker-gauge-collection',
  'native-self-http-transport',
  `native-metric-format-${METRIC_SERIALIZATION_VERSION}`,
] as const;

export const TASK_PROCESS_PATHS = {
  health: '/v3/health',
  run: '/v3/run',
  metrics: '/v3/metrics',
} as const;

const protocolSchema = schema.object(
  {
    protocolVersion: schema.number(),
    capabilities: schema.arrayOf(schema.string({ maxLength: 128 }), { maxSize: 128 }),
  },
  { unknowns: 'ignore' }
);

/** Rejects workers that cannot implement the dispatch contract before any task is started. */
export const assertTaskProcessProtocol = (peer: {
  protocolVersion: number;
  capabilities: readonly string[];
}): void => {
  let validated: ReturnType<typeof protocolSchema.validate>;
  try {
    validated = protocolSchema.validate(peer);
  } catch {
    throw new TaskProcessAcquireError('incompatible', 'Task worker has invalid protocol metadata');
  }
  if (validated.protocolVersion !== TASK_PROCESS_PROTOCOL_VERSION) {
    throw new TaskProcessAcquireError(
      'incompatible',
      `Task worker protocol ${validated.protocolVersion} does not match ${TASK_PROCESS_PROTOCOL_VERSION}`
    );
  }
  const missing = TASK_PROCESS_CAPABILITIES.filter(
    (capability) => !validated.capabilities.includes(capability)
  );
  if (missing.length) {
    throw new TaskProcessAcquireError(
      'incompatible',
      `Task worker lacks protocol capabilities: ${missing.join(', ')}`
    );
  }
};

/** Parses bounded capability metadata returned by the worker health endpoint. */
export const parseTaskProcessProtocol = (json: string): void => {
  if (Buffer.byteLength(json) > 64 * 1024) {
    throw new TaskProcessAcquireError('incompatible', 'Task worker protocol metadata is too large');
  }
  try {
    assertTaskProcessProtocol(JSON.parse(json));
  } catch (error) {
    if (error instanceof TaskProcessAcquireError) throw error;
    throw new TaskProcessAcquireError('incompatible', 'Task worker has invalid protocol metadata');
  }
};
