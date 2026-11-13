/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest, Logger } from '@kbn/core/server';
import type { WorkflowStepsContributionContext } from '@kbn/workflows-extensions/server';
import type { CasesServerSetup } from '../types';

export const CASES_ATTACHMENT_TYPES_CONTRIBUTION_KEY = 'cases-attachment-types';

export interface CasesAttachmentTypeContributionContext {
  settings: WorkflowStepsContributionContext['settings'];
  logger: Logger;
  getScopedElasticsearchClient: (request: KibanaRequest) => Promise<ElasticsearchClient>;
}

export interface CasesAttachmentTypeContribution {
  readonly typeIds: readonly string[];
  declares?: { settings?: string[] };
  register: (
    attachmentFramework: CasesServerSetup['attachmentFramework'],
    context: CasesAttachmentTypeContributionContext
  ) => void;
}
