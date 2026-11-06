/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { PerformanceMetricEvent } from '@kbn/ebt-tools-common';
import { reportPerformanceMetricEvent } from '@kbn/ebt-tools-common';
import type { Optional } from 'utility-types';
import type { FileAnalytics } from './analytics';
import { getFileAnalytics } from './analytics';

export interface PerfArgs {
  eventData: Optional<PerformanceMetricEvent, 'duration'>;
  analytics?: FileAnalytics;
}

export async function withReportPerformanceMetric<T>(perfArgs: PerfArgs, cb: () => Promise<T>) {
  const analytics = perfArgs.analytics ?? getFileAnalytics();

  const start = performance.now();
  const response = await cb();
  const end = performance.now();

  if (analytics) {
    reportPerformanceMetricEvent(analytics, {
      ...perfArgs.eventData,
      duration: end - start,
    });
  }

  return response;
}
