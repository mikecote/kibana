/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createPrivateTemporaryDirectory } from '@kbn/fs';
import type { PrivateTemporaryDirectory } from '@kbn/fs';

export interface ContentReference {
  __kind: 'content';
  digest: string;
  size: number;
}

/** Verifies and caches installed assets under the worker-owned temporary data directory. */
export class ContentCache {
  private readonly pending = new Map<string, Promise<string>>();
  private directory?: PrivateTemporaryDirectory;
  constructor(private readonly fetch: (digest: string) => Promise<string>) {}

  cleanup(): void {
    this.directory?.cleanup();
  }

  read(reference: ContentReference): Promise<string> {
    const { digest, size } = reference;
    if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 0) {
      return Promise.reject(new Error('Invalid installed content reference'));
    }
    let pending = this.pending.get(digest);
    if (!pending) {
      pending = this.load(digest, size).finally(() => this.pending.delete(digest));
      this.pending.set(digest, pending);
    }
    return pending.then((text) => {
      this.verify(text, digest, size);
      return text;
    });
  }

  private async load(digest: string, size: number): Promise<string> {
    this.directory ??= createPrivateTemporaryDirectory('kbn-task-content-');
    const file = this.directory.getPath(digest);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      text = await this.fetch(digest);
      this.verify(text, digest, size);
      // Coalesced per-digest writes; readers never observe a partially written entry.
      this.directory.writeFile(digest, text);
    }
    this.verify(text, digest, size);
    return text;
  }

  private verify(text: string, digest: string, size: number): void {
    if (
      Buffer.byteLength(text) !== size ||
      createHash('sha256').update(text).digest('hex') !== digest
    ) {
      throw new Error('Installed content digest or size mismatch');
    }
  }
}
