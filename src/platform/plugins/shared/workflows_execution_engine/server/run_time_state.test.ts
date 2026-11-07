/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { KibanaRequest } from '@kbn/core/server';
import {
  defaultExecutionIdentityContexts,
  ExecutionIdentityContexts,
  getWorkflowOriginalRequest,
} from './service_account_execution';
import {
  defaultHitlLifecycleAuditRegistry,
  emitHitlLifecycle,
  HitlLifecycleAuditRegistry,
  registerHitlLifecycleAuditor,
} from './step/wait_for_input_step/hitl_lifecycle_auditor';

describe('ExecutionIdentityContexts', () => {
  const original = { id: 'original' } as unknown as KibanaRequest;
  const scoped = { id: 'scoped' } as unknown as KibanaRequest;
  const context = { originalRequest: original, execution: {} as never };

  it('keeps one set of contexts per instance', () => {
    const first = new ExecutionIdentityContexts();
    const second = new ExecutionIdentityContexts();
    first.set(scoped, context);
    expect(getWorkflowOriginalRequest(scoped, first)).toBe(original);
    expect(getWorkflowOriginalRequest(scoped, second)).toBe(scoped);
    first.delete(scoped);
    expect(getWorkflowOriginalRequest(scoped, first)).toBe(scoped);
  });

  it('uses the shared default instance when none is given', () => {
    defaultExecutionIdentityContexts.set(scoped, context);
    expect(getWorkflowOriginalRequest(scoped)).toBe(original);
    defaultExecutionIdentityContexts.delete(scoped);
    expect(getWorkflowOriginalRequest(scoped)).toBe(scoped);
  });
});

describe('HitlLifecycleAuditRegistry', () => {
  it('audits on the registry it is given and on no other', () => {
    const own = new HitlLifecycleAuditRegistry();
    const auditor = jest.fn();
    own.register(auditor);
    emitHitlLifecycle({ type: 'waiting', executionId: 'e' }, own);
    expect(auditor).toHaveBeenCalledWith({ type: 'waiting', executionId: 'e' });
    const other = jest.fn();
    defaultHitlLifecycleAuditRegistry.register(other);
    emitHitlLifecycle({ type: 'canceled', executionId: 'e2' }, own);
    expect(other).not.toHaveBeenCalled();
    defaultHitlLifecycleAuditRegistry.register(jest.fn())();
  });

  it('keeps registerHitlLifecycleAuditor on the default registry, which emit uses by default', () => {
    const auditor = jest.fn();
    const dispose = registerHitlLifecycleAuditor(auditor);
    emitHitlLifecycle({ type: 'timed_out', executionId: 'e3' });
    expect(auditor).toHaveBeenCalledWith({ type: 'timed_out', executionId: 'e3' });
    dispose();
    emitHitlLifecycle({ type: 'timed_out', executionId: 'e4' });
    expect(auditor).toHaveBeenCalledTimes(1);
  });

  it('never lets a failing auditor affect the run', () => {
    const registry = new HitlLifecycleAuditRegistry();
    registry.register(() => {
      throw new Error('boom');
    });
    expect(() => registry.emit({ type: 'waiting', executionId: 'e' })).not.toThrow();
  });
});
