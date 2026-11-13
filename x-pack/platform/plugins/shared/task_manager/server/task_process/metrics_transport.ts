/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { decodeMetricResources } from '@kbn/metrics';
import type { MetricResourceSnapshot } from '@kbn/metrics';
import type { TaskProcessAddress } from './remote_task_runner';
import { TASK_PROCESS_PATHS } from './protocol';

/** Collects authenticated live gauge snapshots through the native bulk telemetry endpoint. */
export const collectRemoteGaugeMetrics = async (
  address: TaskProcessAddress,
  owner: string
): Promise<MetricResourceSnapshot[]> => {
  const url = `${address.url.replace(/\/+$/, '')}${
    TASK_PROCESS_PATHS.metrics
  }?owner=${encodeURIComponent(owner)}`;
  const response = await fetch(url, {
    headers: address.token ? { authorization: `Bearer ${address.token}` } : {},
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Native gauge collection returned HTTP ${response.status}`);
  }
  const body: { encoded: string } = await response.json();
  return decodeMetricResources(body.encoded);
};
