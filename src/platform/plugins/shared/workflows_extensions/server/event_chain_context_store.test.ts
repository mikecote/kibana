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
  createEventChainContextStore,
  defaultEventChainContextStore,
  getEventChainContext,
  setWorkflowEventChainContext,
} from './event_chain_context';

describe('event chain context store', () => {
  const request = () => ({ headers: {}, isInternalApiRequest: false } as unknown as KibanaRequest);

  it('is what setWorkflowEventChainContext and getEventChainContext use', () => {
    const req = request();
    setWorkflowEventChainContext(req, { depth: 2, sourceExecutionId: 'exec' });
    expect(defaultEventChainContextStore.get(req)).toEqual({ depth: 2, sourceExecutionId: 'exec' });

    const other = request();
    defaultEventChainContextStore.set(other, { depth: 4 });
    expect(getEventChainContext(other)).toEqual({ depth: 4 });
  });

  it('records the context under its own key when made with one', () => {
    const store = createEventChainContextStore(Symbol('own'));
    const req = request();
    store.set(req, { depth: 1 });
    expect(store.get(req)).toEqual({ depth: 1 });
    expect(getEventChainContext(req)).toBeUndefined();
  });
});
