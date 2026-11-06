/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { InternalHttpServiceStart } from '@kbn/core-http-server-internal';
import type { InternalSecurityServiceStart } from '@kbn/core-security-server-internal';
import {
  ES_CLIENT_AUTHENTICATION_HEADER,
  HTTPAuthorizationHeader,
  isUiamCredential,
  UIAM_INTERNAL_CALLER_ATTESTATION_HEADER,
} from '@kbn/core-security-server';

/** Connects the outbound self client to Core’s UIAM delegate. */
export const configureSelfClientSecurity = (
  http: Pick<InternalHttpServiceStart, 'setSelfClientUiamAttestationGetter'>,
  security: InternalSecurityServiceStart
): void => {
  const uiam = security.authc.apiKeys.uiam;
  if (uiam) {
    http.setSelfClientUiamAttestationGetter((request, outboundAuthorization) => {
      const credential = outboundAuthorization
        ? HTTPAuthorizationHeader.parseFromValue(outboundAuthorization)
        : null;
      if (!credential || !isUiamCredential(credential)) {
        return undefined;
      }
      if (uiam.isExternalApiKey(request)) {
        return undefined;
      }

      const inboundClientSecret = request.headers[ES_CLIENT_AUTHENTICATION_HEADER];
      let inboundSecrets: string[] = [];
      if (typeof inboundClientSecret === 'string') {
        inboundSecrets = [inboundClientSecret];
      } else if (Array.isArray(inboundClientSecret)) {
        inboundSecrets = inboundClientSecret;
      }
      const hasUpstreamSecret = inboundSecrets.some(
        (entry) => entry.length > 0 && !uiam.isOwnClientAuthentication(entry)
      );
      if (hasUpstreamSecret) {
        return undefined;
      }

      return uiam.getInternalCallerAttestationHeaders(credential)[
        UIAM_INTERNAL_CALLER_ATTESTATION_HEADER
      ];
    });
  }
};
