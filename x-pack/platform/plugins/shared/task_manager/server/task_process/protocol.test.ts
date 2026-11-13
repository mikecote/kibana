/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TaskProcessAcquireError } from './acquire_error';
import {
  assertTaskProcessProtocol,
  parseTaskProcessProtocol,
  TASK_PROCESS_PROTOCOL_VERSION,
  TASK_PROCESS_CAPABILITIES,
} from './protocol';

const current = {
  protocolVersion: TASK_PROCESS_PROTOCOL_VERSION,
  capabilities: [...TASK_PROCESS_CAPABILITIES],
};

it('accepts the current contract and additive capabilities', () => {
  expect(() =>
    assertTaskProcessProtocol({ ...current, capabilities: [...current.capabilities, 'future'] })
  ).not.toThrow();
});

it('rejects old and future protocols before business execution', () => {
  for (const protocolVersion of [1, 2, 4]) {
    expect(() => assertTaskProcessProtocol({ ...current, protocolVersion })).toThrow(
      TaskProcessAcquireError
    );
  }
});

it.each(TASK_PROCESS_CAPABILITIES)('requires the %s capability', (removed) => {
  expect(() =>
    assertTaskProcessProtocol({
      ...current,
      capabilities: current.capabilities.filter((capability) => capability !== removed),
    })
  ).toThrow(`Task worker lacks protocol capabilities: ${removed}`);
});

it('rejects invalid, absent and oversized capability metadata', () => {
  for (const metadata of [
    '{}',
    'invalid JSON',
    JSON.stringify({ ...current, capabilities: [1] }),
    JSON.stringify({ ...current, capabilities: Array(129).fill('future') }),
    JSON.stringify({ ...current, capabilities: ['x'.repeat(129)] }),
    ' '.repeat(64 * 1024 + 1),
  ]) {
    expect(() => parseTaskProcessProtocol(metadata)).toThrow(TaskProcessAcquireError);
  }
});
