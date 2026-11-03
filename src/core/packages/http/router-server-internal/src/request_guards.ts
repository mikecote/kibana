/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Request } from '@hapi/hapi';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { CoreKibanaRequest } from './request';

/**
 * Request type guards, kept free of runtime imports so that code that only needs to recognise a
 * request (the Elasticsearch client, task runtimes) does not load the validator, hapi or the router.
 */

/** Holds the raw hapi request on a `CoreKibanaRequest`. */
export const requestSymbol = Symbol('request');

/** Set on `CoreKibanaRequest.prototype`; lets `isKibanaRequest` work without importing the class. */
export const kibanaRequestBrand = Symbol.for('kbn.core.http.CoreKibanaRequest');

/**
 * Checks if an incoming request is a {@link KibanaRequest}
 * @internal
 */
export function isKibanaRequest(request: unknown): request is CoreKibanaRequest {
  return (
    typeof request === 'object' &&
    request !== null &&
    (request as Record<symbol, unknown>)[kibanaRequestBrand] === true
  );
}

export const ensureRawRequest = (request: KibanaRequest | Request): Request =>
  isKibanaRequest(request)
    ? (request as unknown as Record<symbol, Request>)[requestSymbol]
    : (request as Request);

export function isRealRawRequest(request: any): request is Request {
  try {
    return (
      request.raw.req &&
      typeof request.raw.req === 'object' &&
      request.raw.res &&
      typeof request.raw.res === 'object'
    );
  } catch {
    return false;
  }
}

/**
 * Checks if an incoming request either KibanaRequest or Hapi.Request
 * @internal
 */
export function isRealRequest(request: unknown): request is KibanaRequest | Request {
  return (isKibanaRequest(request) && !request.isFakeRequest) || isRealRawRequest(request);
}
