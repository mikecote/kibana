/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { ImpactService } from '../impact/services/impact_service';
import { createImpactStorageClient } from '../impact/storage/impact_storage';
import { subjectAttachment } from '../subjects/attachments';
import { SubjectsService } from '../subjects/services/subjects_service';
import {
  createSubjectClaimStorageClient,
  SubjectClaimsService,
} from '../subjects/services/subject_claims_service';
import { hypothesesAttachment } from '../hypotheses/attachments';
import { HypothesesService } from '../hypotheses/services/hypotheses_service';

export interface InvestigationDocumentServices {
  impactService: ImpactService;
  subjectsService: SubjectsService;
  hypothesesService: HypothesesService;
}

/** Builds the native investigation document stores shared by Kibana and workflow workers. */
export const createInvestigationDocumentServices = ({
  esClient,
  logger,
}: {
  esClient: ElasticsearchClient;
  logger: Logger;
}): InvestigationDocumentServices => ({
  impactService: new ImpactService({ storage: createImpactStorageClient({ esClient, logger }) }),
  subjectsService: new SubjectsService({
    documents: subjectAttachment.createService({ esClient, logger }),
    claims: new SubjectClaimsService({
      storage: createSubjectClaimStorageClient({ esClient, logger }),
    }),
  }),
  hypothesesService: new HypothesesService({
    documents: hypothesesAttachment.createService({ esClient, logger }),
  }),
});
