/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup } from '@kbn/core/server';
import type { KibanaRequest } from '@kbn/core-http-server';
import type { Logger } from '@kbn/logging';
import type { ToolAvailabilityResult } from '@kbn/agent-builder-server';
import type { CasesServerStartDependencies } from '../../types';

import { createCasesToolServices } from '../cases_tool_services';
import type { CasesToolServices } from '../cases_tool_services';

/** Solutions where Cases is available (undefined = stateful, no gating). */
const ALLOWED_SOLUTIONS = new Set(['classic', 'oblt', 'security', undefined]);

export async function getCasesToolAvailability({
  core,
  logger,
  request,
}: {
  core: CoreSetup<CasesServerStartDependencies>;
  logger: Logger;
  request: KibanaRequest;
}): Promise<ToolAvailabilityResult> {
  return getCasesToolAvailabilityWithServices({
    services: createCasesToolServices(core),
    logger,
    request,
  });
}

const getCasesToolAvailabilityWithServices = async ({
  services,
  logger,
  request,
}: {
  services: CasesToolServices;
  logger: Logger;
  request: KibanaRequest;
}): Promise<ToolAvailabilityResult> => {
  try {
    const activeSpace = await services.getActiveSpace(request);
    if (!ALLOWED_SOLUTIONS.has(activeSpace?.solution)) {
      return {
        status: 'unavailable',
        reason: 'Cases is not available in this project type',
      };
    }
  } catch (error) {
    logger.debug('Cases tool availability check failed, defaulting to available.');
    logger.debug(error);
  }
  return { status: 'available' };
};

/**
 * Returns the availability config object to attach to a Cases tool definition.
 * Uses cacheMode 'space' so the check runs once per space, not per request.
 */
export const createCasesToolAvailability = (
  core: CoreSetup<CasesServerStartDependencies>,
  logger: Logger
) => createCasesToolAvailabilityWithServices(createCasesToolServices(core), logger);

export const createCasesToolAvailabilityWithServices = (
  services: CasesToolServices,
  logger: Logger
) => ({
  cacheMode: 'space' as const,
  handler: ({ request }: { request: KibanaRequest }) =>
    getCasesToolAvailabilityWithServices({ services, logger, request }),
});
