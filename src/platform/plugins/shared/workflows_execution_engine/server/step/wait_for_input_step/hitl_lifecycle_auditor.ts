/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Late-bound HITL lifecycle auditor. Registered by workflows_management at start
 * so the engine stays free of a `security` dependency while still emitting
 * security-audit events through {@link WorkflowManagementAuditLog}.
 */

export type HitlLifecycleEvent =
  | {
      type: 'waiting';
      executionId: string;
      stepExecutionId?: string;
      stepType?: string;
    }
  | {
      type: 'timed_out';
      executionId: string;
      stepExecutionId?: string;
      stepType?: string;
    }
  | {
      type: 'canceled';
      executionId: string;
      stepExecutionId?: string;
    };

export type HitlLifecycleAuditor = (event: HitlLifecycleEvent) => void;

/**
 * Holds the late-bound auditor. One lives in each workflow runtime; the default instance is the one
 * {@link registerHitlLifecycleAuditor} registers on, so in Kibana the runtime uses it and
 * workflows_management reaches it through the public `registerHitlLifecycleAuditor`.
 */
export class HitlLifecycleAuditRegistry {
  private auditor: HitlLifecycleAuditor | undefined;

  /**
   * Registers the late-bound HITL lifecycle auditor. Returns a disposer that
   * clears the registration only if this auditor is still the active one.
   */
  register(auditor: HitlLifecycleAuditor): () => void {
    this.auditor = auditor;
    return () => {
      if (this.auditor === auditor) {
        this.auditor = undefined;
      }
    };
  }

  emit(event: HitlLifecycleEvent): void {
    try {
      this.auditor?.(event);
    } catch {
      // Best-effort: never let audit affect workflow execution.
    }
  }
}

export const defaultHitlLifecycleAuditRegistry = new HitlLifecycleAuditRegistry();

/**
 * Registers the late-bound HITL lifecycle auditor on the default registry. Returns a disposer that
 * clears the registration only if this auditor is still the active one.
 */
export const registerHitlLifecycleAuditor = (auditor: HitlLifecycleAuditor): (() => void) =>
  defaultHitlLifecycleAuditRegistry.register(auditor);

export const emitHitlLifecycle = (
  event: HitlLifecycleEvent,
  registry: Pick<HitlLifecycleAuditRegistry, 'emit'> = defaultHitlLifecycleAuditRegistry
): void => registry.emit(event);
