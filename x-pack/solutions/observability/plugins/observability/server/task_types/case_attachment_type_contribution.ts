/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CasesAttachmentTypeContribution } from '@kbn/cases-plugin/server';
import { observabilityAlertAttachmentType } from '../cases/attachments/alert';

export const contribution: CasesAttachmentTypeContribution = {
  typeIds: [observabilityAlertAttachmentType.id],
  register: (attachmentFramework) =>
    attachmentFramework.registerAttachment(observabilityAlertAttachmentType),
};
