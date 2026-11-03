/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { readLimits, updateBundleLimits, validateBundleLimits } = require('./limits');

describe('task bundle limits', () => {
  const limits = { bundleBytes: { a: 1000, b: 2000 } };

  it('accepts bundles within their limits', () => {
    expect(
      validateBundleLimits(
        [
          { name: 'a', bytes: 900 },
          { name: 'b', bytes: 2000 },
        ],
        limits
      )
    ).toEqual([]);
  });

  it('reports a bundle over its limit, without a limit, and a limit without a bundle', () => {
    const errors = validateBundleLimits(
      [
        { name: 'a', bytes: 1001 },
        { name: 'c', bytes: 1 },
      ],
      limits
    );
    expect(errors).toEqual([
      'a is 1001 bytes, over its limit of 1000',
      'c has no limit; run --update-limits',
      'b has a limit but no bundle',
    ]);
  });

  it('writes limits with headroom, keeps limits that still fit and refuses large jumps', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'limits-')), 'limits.yml');
    expect(updateBundleLimits([{ name: 'a', bytes: 1000000 }], { file })).toEqual([]);
    expect(readLimits(file).bundleBytes.a).toBe(1100000);

    expect(updateBundleLimits([{ name: 'a', bytes: 900000 }], { file })).toEqual([]);
    expect(readLimits(file).bundleBytes.a).toBe(1100000);

    expect(updateBundleLimits([{ name: 'a', bytes: 2000000 }], { file })).toEqual([
      'a grew from 1100000 to 2200000; pass --force if that is intended',
    ]);
    expect(updateBundleLimits([{ name: 'a', bytes: 2000000 }], { file, force: true })).toEqual([]);
    expect(readLimits(file).bundleBytes.a).toBe(2200000);
  });
});
