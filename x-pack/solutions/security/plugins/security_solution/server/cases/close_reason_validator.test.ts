/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core/server/mocks';
import { DEFAULT_DETECTIONS_CLOSE_REASONS_KEY } from '../../common/constants';
import { createSecurityCloseReasonValidator } from './close_reason_validator';

it('validates defaults and custom reasons using the request-scoped UI settings client', async () => {
  const firstRequest = httpServerMock.createKibanaRequest();
  const secondRequest = httpServerMock.createKibanaRequest();
  const get = jest.fn().mockResolvedValue(['custom_close_reason']);
  const getSettings = jest.fn(async () => ({ get }));
  const validate = createSecurityCloseReasonValidator(getSettings);
  expect(await validate('false_positive', firstRequest)).toBe(true);
  expect(await validate('custom_close_reason', firstRequest)).toBe(true);
  expect(await validate('invalid_reason', firstRequest)).toBe(false);
  get.mockResolvedValueOnce([]);
  expect(await validate('custom_close_reason', secondRequest)).toBe(false);
  expect(getSettings).toHaveBeenLastCalledWith(secondRequest);
  expect(get).toHaveBeenCalledWith(DEFAULT_DETECTIONS_CLOSE_REASONS_KEY);
});
