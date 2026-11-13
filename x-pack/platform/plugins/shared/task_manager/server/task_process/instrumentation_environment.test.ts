/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { applyTaskProcessInstrumentationEnvironment } from './instrumentation_environment';

beforeEach(() => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    ELASTIC_APM_ACTIVE: 'false',
    OTEL_RESOURCE_ATTRIBUTES: 'native.source=worker',
    TASK_PROCESS_ENV_PROOF: 'preserved',
  });
});
afterEach(() => jest.restoreAllMocks());

it('replaces stale worker instrumentation settings with Main settings and preserves other environment', () => {
  applyTaskProcessInstrumentationEnvironment({ ELASTIC_APM_ACTIVE: 'true' });
  expect(process.env.ELASTIC_APM_ACTIVE).toBe('true');
  expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
  expect(process.env.TASK_PROCESS_ENV_PROOF).toBe('preserved');
});

it('validates every key before changing any environment variable', () => {
  expect(() =>
    applyTaskProcessInstrumentationEnvironment({ TASK_PROCESS_ENV_PROOF: 'modified' })
  ).toThrow('unrelated environment variable');
  expect(process.env.TASK_PROCESS_ENV_PROOF).toBe('preserved');
  expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe('native.source=worker');
});
