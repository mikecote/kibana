/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IScopedClusterClient, Logger } from '@kbn/core/server';
import type { FakeRawRequest } from '@kbn/core-http-server';
import { kibanaRequestFactory } from '@kbn/core-http-server-utils';
import { asSpaceId } from '@kbn/core-spaces-common';
import { isWorkflowsEnabled } from '@kbn/discoveries/impl/lib/helpers/is_workflows_enabled';
import type {
  AttackDiscoveryWorkflowExecutor,
  AttackDiscoveryWorkflowExecutorDeps,
} from '@kbn/discoveries/impl/attack_discovery/workflow_executor_contribution';
import { workflowExecutor } from '.';

/**
 * Extracts authorization headers from the alerting framework's pre-authenticated
 * scoped cluster client for use in the workflow execution engine's fake request.
 *
 * The alerting framework authenticates rule executors via the rule's stored
 * API key, but only exposes pre-scoped clients — not the authenticated
 * KibanaRequest. The workflow execution engine needs an authenticated
 * KibanaRequest to create its own scoped services, so this function bridges
 * the gap by extracting the authorization header from the scoped client's
 * transport layer.
 */
const createWorkflowAuthHeaders = async ({
  executionId,
  logger,
  scopedClusterClient,
}: {
  executionId: string;
  logger: Logger;
  scopedClusterClient: IScopedClusterClient;
}): Promise<Record<string, string>> => {
  try {
    const esClient = scopedClusterClient.asCurrentUser;

    // The scoped ES client's transport stores the authorization header that
    // the alerting framework derived from the rule's stored API key. We extract
    // it directly instead of creating a derived API key, which avoids the
    // "illegal_argument_exception: creating derived api keys requires an
    // explicit role descriptor" limitation.
    const transportHeaders: Record<string, string> =
      (esClient.transport as unknown as { headers: Record<string, string> }).headers ?? {};

    if (transportHeaders.authorization) {
      return { authorization: transportHeaders.authorization };
    }

    logger.warn(
      () => `No authorization header found in scoped client transport for execution ${executionId}`
    );
    return {};
  } catch (error) {
    logger.warn(
      () => `Failed to extract auth headers for workflow execution ${executionId}: ${error.message}`
    );

    return {};
  }
};

/**
 * The executor of the scheduled attack discovery rules that carry a `workflowConfig`, built from
 * explicit dependencies: the discoveries plugin builds it from what its start contracts offer, and
 * the task process of the rule type from its host, so a rule runs the same code in both.
 */
export const createAttackDiscoveryWorkflowExecutor =
  (deps: AttackDiscoveryWorkflowExecutorDeps): AttackDiscoveryWorkflowExecutor =>
  async (options) => {
    const { logger } = deps;
    // Kill-switch: when the feature flag is OFF, skip the scheduled AD 2.0 run
    // as a no-op so the rule stays healthy (no error, no LLM/alert work). Only
    // schedules carrying a `workflowConfig` reach this factory, so the legacy
    // (non-AD-2.0) scheduled path is unaffected.
    if (!(await isWorkflowsEnabled(deps.featureFlags))) {
      logger.debug(
        () =>
          `Attack Discovery workflows disabled; skipping scheduled execution ${options.executionId}`
      );
      return { state: {} };
    }

    // The alerting framework authenticates via the rule's stored API key but
    // only exposes pre-scoped clients — NOT the authenticated KibanaRequest.
    // The workflow execution engine needs an authenticated KibanaRequest to
    // create its own scoped services (ES client, actions client, etc.), so we
    // take the credential of the alerting framework's scoped client. No API key is granted here.
    const authHeaders = await createWorkflowAuthHeaders({
      executionId: options.executionId,
      logger,
      scopedClusterClient: options.services.scopedClusterClient,
    });

    // Scope the synthetic request to the rule's space (the alerting
    // framework's authoritative `options.spaceId`). `CoreKibanaRequest`
    // reads `FakeRawRequest.spaceId`, so the single `getSpaceId({ request })`
    // path inside `executeGenerationWorkflow` resolves the correct space for
    // the authorization guard, anonymization, integrity check, and event log.
    const fakeRawRequest: FakeRawRequest = {
      headers: authHeaders,
      path: '/',
      spaceId: asSpaceId(options.spaceId),
    };
    const request = kibanaRequestFactory(fakeRawRequest);

    return workflowExecutor({ deps: { ...deps, request }, options });
  };
