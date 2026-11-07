/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { RequestHandler, RouteMethod } from '@kbn/core/server';
import { wrapRouteWithLicenseCheck } from '@kbn/licensing-plugin/server';
import { checkWorkflowsLicense } from '../../../availability/check_workflows_license';
import type { WorkflowsRequestHandlerContext } from '../../../types';

interface AvailabilityCheckOptions {
  bootstrapExecutionDataViews?: boolean;
}

const withServerlessAvailabilityCheck =
  <P = unknown, Q = unknown, B = unknown, Method extends RouteMethod = never>(
    handler: RequestHandler<P, Q, B, WorkflowsRequestHandlerContext, Method>,
    { bootstrapExecutionDataViews = true }: AvailabilityCheckOptions
  ): RequestHandler<P, Q, B, WorkflowsRequestHandlerContext, Method> =>
  async (context, request, response) => {
    const { isWorkflowsAvailable } = await context.workflows;
    if (!isWorkflowsAvailable) {
      return response.forbidden({
        body: {
          message:
            'Your project does not have Workflows available. Please upgrade your tier subscription.',
        },
      });
    }
    if (bootstrapExecutionDataViews) {
      // Access the lazy context to start the per-space data-view bootstrap.
      await context.workflowsManagement;
    }
    return handler(context, request, response);
  };

/**
 * Wraps a request handler with a license and serverless availability check.
 * If workflows are not available in this environment, it will return a 403 (FORBIDDEN) error with a message.
 */
export const withAvailabilityCheck = <
  P = unknown,
  Q = unknown,
  B = unknown,
  Method extends RouteMethod = never
>(
  handler: RequestHandler<P, Q, B, WorkflowsRequestHandlerContext, Method>,
  options: AvailabilityCheckOptions = {}
): RequestHandler<P, Q, B, WorkflowsRequestHandlerContext, Method> =>
  wrapRouteWithLicenseCheck(
    checkWorkflowsLicense,
    withServerlessAvailabilityCheck(handler, options)
  );
