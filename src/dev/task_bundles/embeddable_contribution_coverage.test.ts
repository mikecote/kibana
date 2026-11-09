/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { execFileSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { REPO_ROOT } from '@kbn/repo-info';
import { getPackages } from '@kbn/repo-packages';

it('provides native contributions for every plugin that registers embeddable definitions', () => {
  const registrationFiles = execFileSync(
    'git',
    [
      'grep',
      '-lzE',
      '\\.registerEmbeddableServerDefinition[[:space:]]*\\(',
      '--',
      '*/server/*.ts',
      ':!*.test.ts',
      ':!*.mock.ts',
      ':!*/task_types/*',
      ':!*/task_process/*',
      ':!*/create_embeddable_services.ts',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean);
  const missing = getPackages(REPO_ROOT).flatMap(({ directory, manifest }) => {
    if (manifest.type !== 'plugin') return [];
    const files = registrationFiles.filter((file) =>
      resolve(REPO_ROOT, file).startsWith(`${directory}/`)
    );
    return files.length > 0 && !manifest.plugin.taskTypeContributions?.['embeddables']?.length
      ? [
          {
            plugin: manifest.plugin.id,
            files: files.map((file) => relative(directory, resolve(REPO_ROOT, file))),
          },
        ]
      : [];
  });
  expect(missing).toEqual([]);
});
