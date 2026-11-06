/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { AnalyticsServiceStart } from '@kbn/core/server';

export type FileAnalytics = Pick<AnalyticsServiceStart, 'reportEvent'>;

let analytics: FileAnalytics | undefined;

/** Supplies the default for legacy clients created outside the file service factory. */
export const setFileAnalytics = (client: FileAnalytics | undefined): void => {
  analytics = client;
};

export const getFileAnalytics = (): FileAnalytics | undefined => analytics;
