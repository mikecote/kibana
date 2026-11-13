/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CasesAttachmentTypeContribution } from '@kbn/cases-plugin/server';
import {
  ML_ANOMALY_CHARTS_ATTACHMENT_TYPE,
  ML_ANOMALY_SWIMLANE_ATTACHMENT_TYPE,
  ML_SINGLE_METRIC_VIEWER_ATTACHMENT_TYPE,
} from '@kbn/cases-plugin/common';
import { registerMlCaseAttachments } from '../lib/register_cases';

export const contribution: CasesAttachmentTypeContribution = {
  typeIds: [
    ML_ANOMALY_CHARTS_ATTACHMENT_TYPE,
    ML_ANOMALY_SWIMLANE_ATTACHMENT_TYPE,
    ML_SINGLE_METRIC_VIEWER_ATTACHMENT_TYPE,
  ],
  register: (attachmentFramework, { logger }) =>
    registerMlCaseAttachments(attachmentFramework, logger),
};
