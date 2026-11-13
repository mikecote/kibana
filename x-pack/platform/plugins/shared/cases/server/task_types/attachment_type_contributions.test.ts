/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { readFileSync } from 'fs';
import { loggerMock } from '@kbn/logging-mocks';
import { REPO_ROOT } from '@kbn/repo-info';
import { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';
import { registerInternalAttachments } from '../internal_attachments';
import {
  CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY,
  type CasesAttachmentTypeContribution,
} from './attachment_type_contribution';
import { createCasesAttachmentTypeRegistry } from './create_attachment_type_registry';

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const getContributions = (): Array<{
  owner: string;
  contribution: CasesAttachmentTypeContribution;
}> =>
  git('grep', '-l', `"${CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY}"`, '--', '*kibana.jsonc')
    .split('\n')
    .filter(Boolean)
    .flatMap((manifest) => {
      const source = readFileSync(join(REPO_ROOT, manifest), 'utf8');
      const files = new RegExp(
        `"${CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY}"\\s*:\\s*\\[([^\\]]*)\\]`
      ).exec(source)?.[1];
      return [...(files ?? '').matchAll(/"([^"]+)"/g)].map(([, file]) => ({
        owner: dirname(manifest),
        contribution: (
          jest.requireActual(join(REPO_ROOT, dirname(manifest), file)) as {
            contribution: CasesAttachmentTypeContribution;
          }
        ).contribution,
      }));
    });

describe('Cases attachment contribution coverage', () => {
  it('covers every production plugin registering server-side attachment types', () => {
    const registrants = git(
      'grep',
      '-lE',
      'attachmentFramework\\.registerAttachment',
      '--',
      '*/server/*.ts',
      ':!*test*',
      ':!*/target/*'
    )
      .split('\n')
      .filter(Boolean)
      .map((file) => file.replace(/\/server\/.*$/, ''));
    const contributed = new Set(getContributions().map(({ owner }) => owner));
    const missing = [...new Set(registrants)].filter(
      (owner) => owner !== 'x-pack/platform/plugins/shared/cases' && !contributed.has(owner)
    );
    expect(missing).toEqual([]);
    expect(contributed.size).toBeGreaterThanOrEqual(5);
  });

  it('restores all declared native solution definitions without registration gaps', () => {
    const contributions = getContributions().map(({ contribution }) => contribution);
    const internal = new UnifiedAttachmentTypeRegistry();
    registerInternalAttachments(internal);
    const expected = [
      ...internal.list().map(({ id }) => id),
      ...contributions.flatMap(({ typeIds }) => [...typeIds]),
    ];
    expect(new Set(expected).size).toBe(expected.length);
    const restored = createCasesAttachmentTypeRegistry(
      {
        elasticsearch: elasticsearchServiceMock.createClusterClient(),
        logger: loggerMock.create(),
        settings: {
          securityCaseAttachments: {
            entityAttachmentsEnabled: true,
            attackAttachmentsEnabled: true,
          },
        },
        contributions: { [CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY]: contributions },
      },
      expected
    );
    expect(restored.getParityError()).toBeUndefined();
    expect(
      restored.registry
        .list()
        .map(({ id }) => id)
        .sort()
    ).toEqual(expected.sort());
  });
});
