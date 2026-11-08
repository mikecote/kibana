/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const { resolveTaskContributions, collectTaskFeatureFlags } = require('./build');

describe('resolveTaskContributions', () => {
  it('includes native SDK defaults in bundle metadata with their original primitive types', () => {
    const taskType = { featureFlags: { 'core.enabled': false } };
    expect(
      collectTaskFeatureFlags(taskType, [
        {
          declares: {
            featureFlags: { 'sdk.enabled': true, 'sdk.mode': 'true', 'sdk.limit': 12.5 },
          },
        },
        {},
      ])
    ).toEqual({
      'core.enabled': false,
      'sdk.enabled': true,
      'sdk.mode': 'true',
      'sdk.limit': 12.5,
    });
    expect(taskType.featureFlags).toEqual({ 'core.enabled': false });
  });
  it('discovers nested requirements, terminates cycles and includes additional contributions once', () => {
    const taskType = {
      contributions: {
        keys: ['rules'],
        apply: (contributed) => ({
          contributions: {
            keys: [
              'rules',
              ...(contributed.rules ? ['steps'] : []),
              ...(contributed.steps ? ['tools'] : []),
              ...(contributed.tools ? ['rules'] : []),
            ],
          },
        }),
      },
    };
    const getFiles = jest.fn((key) => [`${key}.ts`]);
    const load = jest.fn((file) => ({ file }));
    expect(
      resolveTaskContributions(taskType, { steps: ['extra.ts', 'steps.ts'] }, getFiles, load)
    ).toEqual({
      rules: ['rules.ts'],
      steps: ['steps.ts', 'extra.ts'],
      tools: ['tools.ts'],
    });
    expect(getFiles.mock.calls).toEqual([['rules'], ['steps'], ['tools']]);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('fails the build when a contribution cannot load or has no exported declaration', () => {
    const module = { contributions: { keys: ['rules'] } };
    expect(() =>
      resolveTaskContributions(
        module,
        {},
        () => ['broken.ts'],
        () => undefined
      )
    ).toThrow('Task contribution broken.ts has no contribution export');
    expect(() =>
      resolveTaskContributions(
        module,
        {},
        () => ['broken.ts'],
        () => {
          throw new Error('invalid native runtime');
        }
      )
    ).toThrow('invalid native runtime');
  });
});
