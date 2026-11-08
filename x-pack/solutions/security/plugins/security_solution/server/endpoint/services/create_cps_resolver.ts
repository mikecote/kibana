/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';

/** Resolves Endpoint fan-out from its feature gate and the request's visible linked projects. */
export const createEndpointCpsResolver =
  (
    enabled: boolean,
    isCpsActive?: (request: KibanaRequest) => Promise<boolean | undefined>
  ): ((request: KibanaRequest) => Promise<boolean>) =>
  async (request) =>
    enabled && (await isCpsActive?.(request)) === true;
