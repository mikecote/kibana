/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { z } from '@kbn/zod/v4';
import { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';
import { registerInternalAttachments } from '../internal_attachments';
import {
  CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY,
  type CasesAttachmentTypeContribution,
} from './attachment_type_contribution';
import { createCasesAttachmentTypeRegistry } from './create_attachment_type_registry';

const getInternalIds = (): string[] => {
  const registry = new UnifiedAttachmentTypeRegistry();
  registerInternalAttachments(registry);
  return registry.list().map(({ id }) => id);
};

const createHost = (contributions: CasesAttachmentTypeContribution[]) => ({
  elasticsearch: elasticsearchServiceMock.createClusterClient(),
  logger: loggerMock.create(),
  contributions: { [CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY]: contributions },
});

describe('native Cases attachment contributions', () => {
  it('restores only the registrations Main selected, with their native validation schema', () => {
    const schema = z.object({ message: z.string().max(100) });
    const host = createHost([
      {
        typeIds: ['test.enabled', 'test.disabled'],
        register: ({ registerAttachment }) => {
          registerAttachment({ id: 'test.enabled', schema });
          registerAttachment({ id: 'test.disabled', schema });
        },
      },
    ]);
    const { registry, getParityError } = createCasesAttachmentTypeRegistry(host, [
      ...getInternalIds(),
      'test.enabled',
    ]);
    expect(registry.get('test.enabled').schema).toBe(schema);
    expect(registry.get('test.enabled').schema.safeParse({ message: 'evidence' }).success).toBe(
      true
    );
    expect(registry.get('test.enabled').schema.safeParse({ message: 42 }).success).toBe(false);
    expect(registry.has('test.disabled')).toBe(false);
    expect(getParityError()).toBeUndefined();
  });

  it('identifies missing solution registrations before a Cases operation can run', () => {
    const { getParityError } = createCasesAttachmentTypeRegistry(createHost([]), [
      ...getInternalIds(),
      'test.missing',
    ]);
    expect(getParityError()).toContain('missing [test.missing]');
  });

  it('identifies built-in registrations absent from Main as incompatible', () => {
    const { getParityError } = createCasesAttachmentTypeRegistry(createHost([]), []);
    expect(getParityError()).toContain('unexpected [');
    expect(getParityError()).toContain(getInternalIds()[0]);
  });

  it('rejects a factory registering an undeclared attachment type', () => {
    const host = createHost([
      {
        typeIds: ['test.declared'],
        register: ({ registerAttachment }) =>
          registerAttachment({ id: 'test.undeclared', schema: z.object({}) }),
      },
    ]);
    expect(() =>
      createCasesAttachmentTypeRegistry(host, [...getInternalIds(), 'test.declared'])
    ).toThrow('Undeclared Cases attachment contribution: test.undeclared');
  });
});
