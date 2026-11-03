/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaRequest } from '@kbn/core-http-server';

interface RequestUser {
  username?: string;
  profile_uid?: string;
}

const requestUsers = new WeakMap<object, RequestUser>();

/** Binds the user Task Manager resolved for a run to the run's fake request. */
export const enrichPodFakeRequest = (
  request: KibanaRequest,
  { profileId, username }: { profileId?: string; username?: string }
) => {
  requestUsers.set(request, { username, profile_uid: profileId });
};

/** The user bound with {@link enrichPodFakeRequest}, or `null` when the request has none. */
export const getPodRequestUser = (request: KibanaRequest) => {
  const user = requestUsers.get(request);
  return user?.username || user?.profile_uid ? user : null;
};
