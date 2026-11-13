/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { ToolAvailabilityResult } from '@kbn/agent-builder-server';
import type { AssertSignificantEventsAccess } from '../../run_services/create_access_checker';

export const createSignificantEventsAvailability = ({
  assertAccess,
  logger,
}: {
  assertAccess: AssertSignificantEventsAccess;
  logger: Logger;
}) => ({
  cacheMode: 'space' as const,
  handler: async (): Promise<ToolAvailabilityResult> => {
    try {
      await assertAccess();
      return { status: 'available' };
    } catch (error) {
      if (error instanceof Error) {
        logger.debug(error.stack ?? error.message);
      } else {
        logger.debug(String(error));
      }
      return {
        status: 'unavailable',
        reason:
          error instanceof Error
            ? error.message
            : 'Significant events access is not available in the current context',
      };
    }
  },
});
