/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest, Logger } from '@kbn/core/server';
import type { CasesServerSetup } from '@kbn/cases-plugin/server';

import type { ExperimentalFeatures } from '../../../common/experimental_features';
import { getEndpointAttachmentType } from './endpoint';
import { getEventAttachmentType } from './event';
import { getIndicatorAttachmentType } from './indicator';
import { getEntityAttachmentType } from './entity';
import { getAttackAttachmentType } from './attack';
import { getTimelineAttachmentType } from './timeline';

export const registerCaseAttachments = (
  attachmentFramework: CasesServerSetup['attachmentFramework'],
  experimentalFeatures: Pick<
    ExperimentalFeatures,
    'entityAttachmentsEnabled' | 'attackAttachmentsEnabled'
  >,
  deps: {
    getScopedElasticsearchClient: (request: KibanaRequest) => Promise<ElasticsearchClient>;
    logger: Logger;
  }
): void => {
  attachmentFramework.registerAttachment(getEndpointAttachmentType());
  attachmentFramework.registerAttachment(getEventAttachmentType());
  attachmentFramework.registerAttachment(getIndicatorAttachmentType());
  if (experimentalFeatures.entityAttachmentsEnabled) {
    attachmentFramework.registerAttachment(getEntityAttachmentType());
  }
  attachmentFramework.registerAttachment(
    getAttackAttachmentType({
      ...deps,
      isAttachEnabled: experimentalFeatures.attackAttachmentsEnabled,
    })
  );
  attachmentFramework.registerAttachment(getTimelineAttachmentType());
};
