/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CasesAttachmentTypeContribution } from '@kbn/cases-plugin/server';
import {
  AIOPS_CHANGE_POINT_CHART_ATTACHMENT_TYPE,
  AIOPS_LOG_RATE_ANALYSIS_ATTACHMENT_TYPE,
  AIOPS_PATTERN_ANALYSIS_ATTACHMENT_TYPE,
} from '@kbn/cases-plugin/common';
import { registerCaseAttachments } from '../register_cases';

export const contribution: CasesAttachmentTypeContribution = {
  typeIds: [
    AIOPS_CHANGE_POINT_CHART_ATTACHMENT_TYPE,
    AIOPS_LOG_RATE_ANALYSIS_ATTACHMENT_TYPE,
    AIOPS_PATTERN_ANALYSIS_ATTACHMENT_TYPE,
  ],
  register: (attachmentFramework, { logger }) =>
    registerCaseAttachments({ attachmentFramework }, logger),
};
