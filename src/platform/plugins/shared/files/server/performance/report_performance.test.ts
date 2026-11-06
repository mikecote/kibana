/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { setFileAnalytics } from './analytics';
import { withReportPerformanceMetric } from './report_performance';

describe('file performance analytics', () => {
  afterEach(() => setFileAnalytics(undefined));

  it('reports through the injected client after the operation finishes', async () => {
    const analytics = { reportEvent: jest.fn() };
    const defaultAnalytics = { reportEvent: jest.fn() };
    setFileAnalytics(defaultAnalytics);
    const result = await withReportPerformanceMetric(
      { analytics, eventData: { eventName: 'download' } },
      async () => {
        expect(analytics.reportEvent).not.toHaveBeenCalled();
        return 'file';
      }
    );
    expect(result).toBe('file');
    expect(analytics.reportEvent).toHaveBeenCalledWith(
      'performance_metric',
      expect.objectContaining({ eventName: 'download', duration: expect.any(Number) })
    );
    expect(defaultAnalytics.reportEvent).not.toHaveBeenCalled();
  });

  it('keeps the plugin default for clients created through the legacy API', async () => {
    const analytics = { reportEvent: jest.fn() };
    setFileAnalytics(analytics);
    await withReportPerformanceMetric({ eventData: { eventName: 'download' } }, async () => 'file');
    expect(analytics.reportEvent).toHaveBeenCalledTimes(1);
  });

  it('does not report a successful operation when it fails', async () => {
    const analytics = { reportEvent: jest.fn() };
    await expect(
      withReportPerformanceMetric({ analytics, eventData: { eventName: 'download' } }, async () => {
        throw new Error('download failed');
      })
    ).rejects.toThrow('download failed');
    expect(analytics.reportEvent).not.toHaveBeenCalled();
  });
});
