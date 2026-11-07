/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SloClient } from '@kbn/slo-plugin/server';
import type { KibanaRequest } from '@kbn/core/server';
import type { SLOServerStart } from '@kbn/slo-plugin/server';

export type ApmSloClient = SloClient;

export async function getApmSloClient({
  plugins,
  request,
}: {
  plugins: {
    slo?: { start: () => Promise<Pick<SLOServerStart, 'getSloClientWithRequest'> | undefined> };
  };
  request: KibanaRequest;
}): Promise<ApmSloClient | undefined> {
  const sloStart = await plugins.slo?.start();

  if (!sloStart) {
    return undefined;
  }

  return sloStart.getSloClientWithRequest(request);
}
