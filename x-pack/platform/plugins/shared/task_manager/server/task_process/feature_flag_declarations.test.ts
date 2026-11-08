/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TaskProcessAcquireError } from './acquire_error';
import {
  assertTaskFeatureFlagValues,
  parseTaskFeatureFlagDeclarations,
} from './feature_flag_declarations';

const taskType = 'workflow:run';
const encode = (featureFlags: object) => JSON.stringify({ taskType, featureFlags });

it('preserves boolean, numeric and string defaults including strings that resemble primitives', () => {
  const flags = { enabled: false, limit: 12.5, mode: 'default', text: 'true', numberText: '123' };
  expect(parseTaskFeatureFlagDeclarations(encode(flags), taskType)).toEqual(flags);
});

it('refuses declarations for a different task before evaluating any flags', () => {
  expect(() => parseTaskFeatureFlagDeclarations(encode({}), 'alerting:test')).toThrow(
    'another task type'
  );
});

it('accepts evaluated false, zero and empty strings without substituting defaults', () => {
  expect(() =>
    assertTaskFeatureFlagValues(
      { enabled: false, limit: 0, mode: '' },
      { enabled: true, limit: 10, mode: 'default' }
    )
  ).not.toThrow();
});

it('refuses missing or incorrectly typed evaluations before business execution', () => {
  expect(() => assertTaskFeatureFlagValues(undefined, { enabled: false })).toThrow('enabled');
  expect(() => assertTaskFeatureFlagValues({}, { enabled: false })).toThrow('enabled');
  expect(() => assertTaskFeatureFlagValues({ enabled: 'false' }, { enabled: false })).toThrow(
    'enabled'
  );
});

it.each([
  'not-json',
  '{}',
  encode({ enabled: null }),
  encode({ enabled: {} }),
  encode({ enabled: [] }),
  encode({ ['x'.repeat(257)]: false }),
  encode({ mode: 'x'.repeat(4097) }),
  encode(Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`flag${index}`, false]))),
  ' '.repeat(64 * 1024 + 1),
])('refuses malformed or oversized declarations: %#', (body) => {
  expect(() => parseTaskFeatureFlagDeclarations(body, taskType)).toThrow(TaskProcessAcquireError);
});
