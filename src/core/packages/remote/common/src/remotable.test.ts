/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { remotable, isRemotableInstance } from './remotable';
import { createToken, remoteTokenId } from './token';

describe('remotable', () => {
  it('marks plain classes without DI metadata and preserves inheritance', () => {
    class Capability {}
    remotable(Capability);
    expect(isRemotableInstance(new Capability())).toBe(true);
    expect(isRemotableInstance(Object.create(Capability.prototype))).toBe(true);
    expect(isRemotableInstance({})).toBe(false);
    expect(isRemotableInstance(null)).toBe(false);
  });

  it('uses stable typed symbols for cross-process identities', () => {
    expect(createToken<object>('test.capability')).toBe(Symbol.for('test.capability'));
    expect(remoteTokenId(createToken<object>('test.capability'))).toBe('test.capability');
    expect(() => remoteTokenId(Symbol('local'))).toThrow('createToken');
    expect(() => createToken<object>('')).toThrow('identity');
  });
});
