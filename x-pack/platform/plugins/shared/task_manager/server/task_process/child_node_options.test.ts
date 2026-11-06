/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { filterNodeArgs, filterNodeOptions, getChildNodeOptions } from './child_node_options';

describe('child node options', () => {
  it('drops the inspector flags in every form', () => {
    expect(
      filterNodeArgs([
        '--inspect',
        '--inspect=9229',
        '--inspect-brk=0.0.0.0:9230',
        '--inspect-port',
        '9231',
        '--inspect-wait',
        '--enable-source-maps',
        '--require=./x.js',
      ])
    ).toEqual(['--enable-source-maps', '--require=./x.js']);
  });

  it('drops heap sizing flags, with their separate values', () => {
    expect(
      filterNodeArgs([
        '--max-old-space-size=4096',
        '--max_old_space_size',
        '4096',
        '--max-semi-space-size=64',
        '--no-warnings',
      ])
    ).toEqual(['--no-warnings']);
  });

  it('does not drop a value that is a flag', () => {
    expect(filterNodeArgs(['--inspect-port', '--no-warnings'])).toEqual(['--no-warnings']);
  });

  it('filters NODE_OPTIONS and leaves nothing when nothing is left', () => {
    expect(filterNodeOptions('--max-old-space-size=4096 --inspect=9229 --enable-source-maps')).toBe(
      '--enable-source-maps'
    );
    expect(filterNodeOptions('--max-old-space-size=4096')).toBeUndefined();
    expect(filterNodeOptions(undefined)).toBeUndefined();
  });

  it('adds the configured heap size', () => {
    expect(
      getChildNodeOptions({
        execArgv: ['--inspect', '--max-old-space-size=8192', '--trace-warnings'],
        nodeOptions: '--max-old-space-size=8192',
        maxOldSpaceMb: 512,
      })
    ).toEqual({
      execArgv: ['--trace-warnings', '--max-old-space-size=512'],
      nodeOptions: undefined,
    });
  });
});
