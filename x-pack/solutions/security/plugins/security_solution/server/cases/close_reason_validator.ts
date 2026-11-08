/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, IUiSettingsClient } from '@kbn/core/server';
import type { CloseReasonValidator } from '@kbn/cases-plugin/server';
import { DEFAULT_DETECTIONS_CLOSE_REASONS_KEY } from '../../common/constants';
import { DefaultClosingReasonSchema } from '../../common/types';

/** Validates default and space-scoped custom Security close reasons with the native UI settings client. */
export const createSecurityCloseReasonValidator =
  (
    getUiSettings: (request: KibanaRequest) => Promise<Pick<IUiSettingsClient, 'get'>>
  ): CloseReasonValidator =>
  async (closeReason, request) => {
    const uiSettings = await getUiSettings(request);
    const customReasons =
      (await uiSettings.get<string[]>(DEFAULT_DETECTIONS_CLOSE_REASONS_KEY)) ?? [];
    return new Set([...DefaultClosingReasonSchema.options, ...customReasons]).has(closeReason);
  };
