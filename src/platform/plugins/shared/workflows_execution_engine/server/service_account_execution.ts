/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import Boom from '@hapi/boom';
import type { KibanaRequest, SecurityServiceStart } from '@kbn/core/server';
import { visitNestedSteps, WorkflowExecuteStepInputSchema } from '@kbn/workflows';
import type { EsWorkflowExecution, WorkflowExecutionEngineModel } from '@kbn/workflows';

export const WORKFLOW_SERVICE_ACCOUNT_TYPE = 'workflow';
type IdentityExecution = Pick<
  EsWorkflowExecution,
  'id' | 'workflowId' | 'spaceId' | 'workflowDefinition' | 'effectiveIdentity' | 'managed'
>;

/**
 * Remembers, for the scoped request of a run as a service account, the request that scheduled it
 * and the execution it runs. One lives in each workflow runtime (one per Kibana node, one per task
 * process); the default instance is what code built without a runtime uses.
 */
export class ExecutionIdentityContexts {
  private readonly contexts = new WeakMap<
    KibanaRequest,
    { originalRequest: KibanaRequest; execution: IdentityExecution }
  >();

  get(request: KibanaRequest) {
    return this.contexts.get(request);
  }

  set(
    request: KibanaRequest,
    context: { originalRequest: KibanaRequest; execution: IdentityExecution }
  ) {
    this.contexts.set(request, context);
  }

  delete(request: KibanaRequest) {
    this.contexts.delete(request);
  }
}

export const defaultExecutionIdentityContexts = new ExecutionIdentityContexts();
const inheritedIdentitySchema = WorkflowExecuteStepInputSchema.pick({
  'workflow-id': true,
  'allowed-workflow-ids': true,
  'allowed-workflow-tags': true,
  'run-as-mode': true,
});

export const getExecutionServiceAccountId = (execution: IdentityExecution): string | undefined =>
  execution.effectiveIdentity?.inheritedFrom
    ? execution.effectiveIdentity.id
    : execution.workflowDefinition?.settings?.run_as;

/** Resolves managed-child delegation from a live parent request and its saved identity choice. */
export const resolveInheritedWorkflowIdentity = (
  request: KibanaRequest,
  workflow: WorkflowExecutionEngineModel,
  context: {
    inheritParentIdentity?: boolean;
    parentWorkflowId?: string;
    parentWorkflowExecutionId?: string;
    parentStepId?: string;
    parentStepName?: string;
    spaceId?: string;
  },
  executionContexts: Pick<ExecutionIdentityContexts, 'get'> = defaultExecutionIdentityContexts
): EsWorkflowExecution['effectiveIdentity'] => {
  if (!context.inheritParentIdentity) return undefined;
  const parent = executionContexts.get(request)?.execution;
  const accountId = parent && getExecutionServiceAccountId(parent);
  if (!parent?.id || !accountId)
    throw Boom.forbidden(
      'Service account inheritance requires a parent executing as a service account.'
    );
  if (parent.managed !== true) {
    throw Boom.forbidden('Only managed parent workflows can delegate a service account.');
  }
  if (
    parent.id !== context.parentWorkflowExecutionId ||
    parent.workflowId !== context.parentWorkflowId ||
    parent.spaceId !== context.spaceId
  ) {
    throw Boom.forbidden(
      'The inherited service account must come from the calling workflow in the same space.'
    );
  }
  let identityChoice: ReturnType<typeof inheritedIdentitySchema.safeParse> | undefined;
  visitNestedSteps(
    [
      ...parent.workflowDefinition.steps,
      ...(parent.workflowDefinition.settings?.['on-failure']?.fallback ?? []),
    ],
    ({ step }) => {
      if (
        step.name === (context.parentStepName ?? context.parentStepId) &&
        (step.type === 'workflow.execute' || step.type === 'workflow.executeAsync') &&
        'with' in step
      ) {
        identityChoice = inheritedIdentitySchema.safeParse(step.with);
      }
    }
  );
  const mode = identityChoice?.success
    ? identityChoice.data['run-as-mode'] ?? 'default'
    : 'default';
  if (!identityChoice?.success || mode === 'default') {
    throw Boom.forbidden(
      'Service account inheritance requires a literal identity choice and, when specified, literal allowed-workflow-ids and allowed-workflow-tags in the parent workflow.'
    );
  }
  const configuredId = identityChoice.data['workflow-id'];
  const allowedIds = identityChoice.data['allowed-workflow-ids'];
  const allowedTags = identityChoice.data['allowed-workflow-tags'];
  const dynamicId = configuredId.includes('{{') || configuredId.includes('{%');
  // Read delegation limits from the saved definition, never from rendered step inputs.
  if (
    (dynamicId ? !allowedIds && !allowedTags : configuredId !== workflow.id) ||
    (allowedIds && !allowedIds.includes(workflow.id)) ||
    (allowedTags && !workflow.definition?.tags?.some((tag) => allowedTags.includes(tag)))
  ) {
    throw Boom.forbidden(
      'The child workflow is not approved to inherit the parent service account. Templated workflow-id requires literal allowed-workflow-ids or allowed-workflow-tags matching the resolved managed child.'
    );
  }
  if (workflow.managed !== true) {
    throw Boom.forbidden('Only managed child workflows can inherit a parent service account.');
  }
  if (mode === 'inherit' && workflow.definition?.settings?.run_as) {
    throw Boom.badRequest('Use run-as-mode: override to replace the child service account.');
  }
  return {
    type: 'service_account',
    id: accountId,
    inheritedFrom: {
      workloadId: parent.effectiveIdentity?.inheritedFrom?.workloadId ?? parent.workflowId,
    },
  };
};

/** Rejects changed delegation before persistence; credential acquisition checks again at run/resume. */
export const ensureInheritedBindingCurrent = async (
  core: { security: Pick<SecurityServiceStart, 'serviceAccounts'> },
  identity: NonNullable<EsWorkflowExecution['effectiveIdentity']>,
  spaceId: string
): Promise<void> => {
  if (!identity.inheritedFrom) return;
  if (!core.security.serviceAccounts.isEnabled()) {
    throw Boom.forbidden('Service account execution is disabled.');
  }
  const binding = await core.security.serviceAccounts.getWorkloadBinding({
    workloadType: WORKFLOW_SERVICE_ACCOUNT_TYPE,
    workloadId: identity.inheritedFrom.workloadId,
    spaceId,
  });
  if (binding?.serviceAccountId !== identity.id) {
    throw Boom.forbidden('The parent service account binding has changed.');
  }
};

export const getWorkflowOriginalRequest = (
  request: KibanaRequest,
  executionContexts: Pick<ExecutionIdentityContexts, 'get'> = defaultExecutionIdentityContexts
): KibanaRequest => executionContexts.get(request)?.originalRequest ?? request;

export const withWorkflowExecutionIdentity = async <T>(
  core: { security: Pick<SecurityServiceStart, 'serviceAccounts'> },
  execution: IdentityExecution,
  request: KibanaRequest,
  execute: (request: KibanaRequest) => Promise<T>,
  executionContexts: ExecutionIdentityContexts = defaultExecutionIdentityContexts
): Promise<T> => {
  const originalRequest = getWorkflowOriginalRequest(request, executionContexts);
  const serviceAccountId = getExecutionServiceAccountId(execution);
  if (!serviceAccountId) {
    return execute(originalRequest);
  }
  if (!core.security.serviceAccounts.isEnabled()) {
    throw Boom.forbidden('Service account execution is disabled.');
  }
  return core.security.serviceAccounts.withScopedRequestForWorkload(
    {
      workloadType: WORKFLOW_SERVICE_ACCOUNT_TYPE,
      workloadId: execution.effectiveIdentity?.inheritedFrom?.workloadId ?? execution.workflowId,
      spaceId: execution.spaceId,
      expectedServiceAccountId: serviceAccountId,
      executionId: execution.id,
    },
    async (scopedRequest) => {
      executionContexts.set(scopedRequest, { originalRequest, execution });
      try {
        return await execute(scopedRequest);
      } finally {
        executionContexts.delete(scopedRequest);
      }
    }
  );
};
