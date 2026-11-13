/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import { createToken } from '@kbn/core-remote-common';
import { remote } from '../remote';

export interface CoordinatorRequestIdentity {
  apiKey: string;
  spaceId: string;
  userName?: string;
  userProfileId?: string;
  uiamApiKeyExternal?: boolean;
}

export interface CoordinatorRequestFactory {
  create(identity: CoordinatorRequestIdentity): KibanaRequest;
}

export const CoordinatorRequestToken = createToken<CoordinatorRequestFactory>(
  remote.capabilities.CoordinatorRequest.token
);
