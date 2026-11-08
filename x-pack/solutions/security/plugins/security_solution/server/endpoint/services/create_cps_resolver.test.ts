/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core-http-server-mocks';
import { createEndpointCpsResolver } from './create_cps_resolver';

it.each([true, false, undefined])('preserves the linked-project answer %s', async (active) => {
  const request = httpServerMock.createKibanaRequest();
  const lookup = jest.fn().mockResolvedValue(active);
  expect(await createEndpointCpsResolver(true, lookup)(request)).toBe(active === true);
  expect(lookup).toHaveBeenCalledWith(request);
});

it('does not look up linked projects when the Endpoint feature is disabled', async () => {
  const lookup = jest.fn().mockResolvedValue(true);
  expect(await createEndpointCpsResolver(false, lookup)(httpServerMock.createKibanaRequest())).toBe(
    false
  );
  expect(lookup).not.toHaveBeenCalled();
});

it('preserves an unavailable CPS plugin and propagates lookup failures', async () => {
  const request = httpServerMock.createKibanaRequest();
  expect(await createEndpointCpsResolver(true)(request)).toBe(false);
  const failure = new Error('Linked project lookup failed');
  await expect(
    createEndpointCpsResolver(true, async () => {
      throw failure;
    })(request)
  ).rejects.toBe(failure);
});
