/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { ContentCache } from './content_cache';

it('fetches on first use, coalesces concurrent reads, and caches without another RPC', async () => {
  const text = '{"module/file":"installed"}';
  const reference = {
    __kind: 'content' as const,
    digest: createHash('sha256').update(text).digest('hex'),
    size: Buffer.byteLength(text),
  };
  const fetch = jest.fn(async () => text);
  const cache = new ContentCache(fetch);
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(await Promise.all([cache.read(reference), cache.read(reference)])).toEqual([text, text]);
    expect(await cache.read(reference)).toBe(text);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(cache.read({ ...reference, size: reference.size + 1 })).rejects.toThrow(
      'mismatch'
    );
    await expect(cache.read({ ...reference, digest: '../escape' })).rejects.toThrow('Invalid');
  } finally {
    cache.cleanup();
  }
});

it('rejects invalid downloaded content without caching it', async () => {
  const fetch = jest.fn(async () => 'corrupt');
  const cache = new ContentCache(fetch);
  const reference = { __kind: 'content' as const, digest: 'a'.repeat(64), size: 7 };
  try {
    await expect(cache.read(reference)).rejects.toThrow('mismatch');
    await expect(cache.read(reference)).rejects.toThrow('mismatch');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    cache.cleanup();
  }
});
