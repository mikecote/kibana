/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSeam } from './seam_log';

describe('recordSeam', () => {
  it('records byte counts without persisting payloads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'remote-seam-'));
    const previous = process.env.KBN_REMOTE_SEAM_LOG;
    try {
      const file = join(directory, 'seam.jsonl');
      process.env.KBN_REMOTE_SEAM_LOG = file;
      recordSeam('Counter.add.request', ['secret']);
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('secret');
      expect(JSON.parse(text)).toEqual({
        name: 'Counter.add.request',
        bytes: Buffer.byteLength(JSON.stringify(['secret'])),
        at: expect.any(String),
      });
    } finally {
      if (previous === undefined) delete process.env.KBN_REMOTE_SEAM_LOG;
      else process.env.KBN_REMOTE_SEAM_LOG = previous;
      rmSync(directory, { recursive: true });
    }
  });
});
