/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CasesAttachmentTypeContribution } from '@kbn/cases-plugin/server';
import {
  INDICATOR_ATTACHMENT_TYPE,
  SECURITY_ALERT_ATTACHMENT_TYPE,
  SECURITY_ATTACK_ATTACHMENT_TYPE,
  SECURITY_ENDPOINT_ATTACHMENT_TYPE,
  SECURITY_ENTITY_ATTACHMENT_TYPE,
  SECURITY_EVENT_ATTACHMENT_TYPE,
  SECURITY_TIMELINE_ATTACHMENT_TYPE,
} from '@kbn/cases-plugin/common';
import type { ExperimentalFeatures } from '../../common/experimental_features';
import { securityAlertAttachmentType } from '../cases/attachments/alert';
import { registerCaseAttachments } from '../cases/attachments/register';

export const SECURITY_CASE_ATTACHMENTS_SETTINGS_ID = 'securityCaseAttachments';
export type SecurityCaseAttachmentsSettings = Pick<
  ExperimentalFeatures,
  'entityAttachmentsEnabled' | 'attackAttachmentsEnabled'
>;

export const contribution: CasesAttachmentTypeContribution = {
  typeIds: [
    INDICATOR_ATTACHMENT_TYPE,
    SECURITY_ALERT_ATTACHMENT_TYPE,
    SECURITY_ATTACK_ATTACHMENT_TYPE,
    SECURITY_ENDPOINT_ATTACHMENT_TYPE,
    SECURITY_ENTITY_ATTACHMENT_TYPE,
    SECURITY_EVENT_ATTACHMENT_TYPE,
    SECURITY_TIMELINE_ATTACHMENT_TYPE,
  ],
  declares: { settings: [SECURITY_CASE_ATTACHMENTS_SETTINGS_ID] },
  register: (attachmentFramework, { settings, logger, getScopedElasticsearchClient }) => {
    const snapshot = settings[SECURITY_CASE_ATTACHMENTS_SETTINGS_ID] as
      | SecurityCaseAttachmentsSettings
      | undefined;
    if (!snapshot)
      throw new Error('Security Cases attachment registrations require their dispatch snapshot');
    registerCaseAttachments(attachmentFramework, snapshot, {
      logger,
      getScopedElasticsearchClient,
    });
    attachmentFramework.registerAttachment(securityAlertAttachmentType);
  },
};
