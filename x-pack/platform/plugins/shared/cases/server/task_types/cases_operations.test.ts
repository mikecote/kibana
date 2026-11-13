/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { CasesClient } from '../client';
import { CasesOperations } from './cases_operations';
import { casesOperationBindings } from './cases_operations_api';

it.each(Object.entries(casesOperationBindings))(
  'forwards only the enumerated %s binding with scoped identity and action source',
  async (operation, [namespace, method]) => {
    const request = {} as KibanaRequest;
    const identity = {
      apiKey: 'resolved-service-account-key',
      spaceId: 'custom',
      userName: 'workflow-user',
      userProfileId: 'profile',
    };
    const create = jest.fn(() => request);
    const call = jest.fn(async () => ({ id: 'case-id' }));
    const client = { [namespace]: { [method]: call } } as unknown as CasesClient;
    const getClient = jest.fn(async () => client);
    const operations = new CasesOperations({ create }, getClient);
    const options = {
      actionSource: { type: 'workflow', id: 'workflow-id', name: 'workflow', runId: 'execution' },
    };
    const args = { test: 'argument' };
    const result = await Reflect.apply(Reflect.get(operations, operation), operations, [
      identity,
      options,
      args,
    ]);
    expect(result).toEqual({ id: 'case-id' });
    expect(create).toHaveBeenCalledWith(identity);
    expect(getClient).toHaveBeenCalledWith(request, options);
    expect(call).toHaveBeenCalledWith(args);
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(operations))
        .filter((name) => name !== 'constructor')
        .sort()
    ).toEqual(Object.keys(casesOperationBindings).sort());
  }
);
