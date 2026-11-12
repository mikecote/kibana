/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TaskProcessAcquireError } from './acquire_error';
import { parseTaskFeatureFlagDeclarations } from './feature_flag_declarations';
import type { TaskFeatureFlagDefinitions } from './feature_flag_declarations';
import { TASK_PROCESS_PATHS } from './protocol';
import type { TaskProcessAddress } from './remote_task_runner';
import type { TaskProcessRunRequest } from './wire';

export const readRemoteFlagDeclarations = async ({
  fetchFn,
  address,
  request,
  abort,
  processUnavailable,
}: {
  fetchFn: typeof fetch;
  address: TaskProcessAddress;
  request: Pick<TaskProcessRunRequest, 'taskType'>;
  abort: AbortSignal;
  processUnavailable: (message: string) => Error;
}): Promise<TaskFeatureFlagDefinitions> => {
  const authHeaders = (peer: TaskProcessAddress): Record<string, string> =>
    peer.token ? { authorization: `Bearer ${peer.token}` } : {};
  const declarationsResponse = await fetchFn(
    `${address.url}${TASK_PROCESS_PATHS.featureFlags}?taskType=${encodeURIComponent(
      request.taskType
    )}`,
    { headers: authHeaders(address), signal: abort }
  );
  if (!declarationsResponse.ok) {
    await declarationsResponse.body?.cancel();
    if (declarationsResponse.status >= 500)
      throw processUnavailable('Task worker feature flag declarations are unavailable');
    throw new TaskProcessAcquireError(
      declarationsResponse.status === 404 ? 'not_served' : 'incompatible',
      `Task worker feature flag negotiation returned HTTP ${declarationsResponse.status}`
    );
  }
  const declared = parseTaskFeatureFlagDeclarations(
    await declarationsResponse.text(),
    request.taskType
  );
  return declared;
};
