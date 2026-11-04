/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getDefaultSecurityImplementation } from '@kbn/core-security-server-internal';
import type { TaskHost } from '../../task_type_module';

/** `withContext` and nothing else: a task process has no execution context to propagate. */
export const standaloneExecutionContext: TaskHost['executionContext'] = {
  withContext: (_context, fn) => fn(),
  getAsLabels: () => ({}),
};

/** Core's default security: no user, no audit, no UIAM keys. */
export const createStandaloneSecurity = (): TaskHost['security'] => {
  const { authc, audit } = getDefaultSecurityImplementation();
  return { authc, audit } as unknown as TaskHost['security'];
};
