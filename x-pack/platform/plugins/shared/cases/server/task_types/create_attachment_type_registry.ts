/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { findMissingParity } from '@kbn/task-manager-plugin/server/task_process/parity';
import { UnifiedAttachmentTypeRegistry } from '../attachment_framework/unified_attachment_registry';
import { registerInternalAttachments } from '../internal_attachments';
import {
  CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY,
  type CasesAttachmentTypeContribution,
} from './attachment_type_contribution';

export interface CasesTaskProcessAttachmentTypes {
  registry: UnifiedAttachmentTypeRegistry;
  getParityError: () => string | undefined;
}

/** Restores the attachment types Main registered using their owning plugins' native factories. */
export const createCasesAttachmentTypeRegistry = (
  host: Pick<TaskHost, 'contributions' | 'elasticsearch' | 'logger' | 'settings'>,
  expectedIds: readonly string[]
): CasesTaskProcessAttachmentTypes => {
  if (!Array.isArray(expectedIds))
    throw new Error('Cases attachment registry snapshot is required');
  const registry = new UnifiedAttachmentTypeRegistry();
  registerInternalAttachments(registry);
  const expected = new Set(expectedIds);
  const contributions = (host.contributions?.[CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY] ??
    []) as CasesAttachmentTypeContribution[];
  for (const contribution of contributions.filter(({ typeIds }) =>
    typeIds.some((id) => expected.has(id))
  )) {
    const declared = new Set(contribution.typeIds);
    contribution.register(
      {
        registerAttachment: (definition) => {
          if (!declared.has(definition.id)) {
            throw new Error(`Undeclared Cases attachment contribution: ${definition.id}`);
          }
          if (expected.has(definition.id)) registry.register(definition);
        },
      },
      {
        logger: host.logger.get('cases', 'attachments'),
        settings: host.settings ?? {},
        getScopedElasticsearchClient: async (request) =>
          host.elasticsearch.asScoped(request).asCurrentUser,
      }
    );
  }
  return {
    registry,
    getParityError: () => {
      const ids = registry.list().map(({ id }) => id);
      const missing = findMissingParity(
        [{ kind: 'cases.attachmentTypes', ids: [...expectedIds] }],
        { 'cases.attachmentTypes': ids }
      );
      const unexpected = findMissingParity([{ kind: 'cases.attachmentTypes', ids }], {
        'cases.attachmentTypes': [...expectedIds],
      });
      if (!missing.length && !unexpected.length) return undefined;
      return `Cases attachment types differ from Main: missing [${missing
        .flatMap((item) => item.ids)
        .join(', ')}], unexpected [${unexpected.flatMap((item) => item.ids).join(', ')}]`;
    },
  };
};
