/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { httpServerMock } from '@kbn/core/server/mocks';
import type { CasesClientContribution } from './client_contribution';
import { createCasesClientExtensions } from './create_client_extensions';

const restore = (
  contributions: CasesClientContribution[],
  closeReasonOwners: string[] = ['securitySolution'],
  hasAlertStatusChangedListeners = false
) =>
  createCasesClientExtensions(
    {
      host: { contributions: { 'cases-client': contributions } },
      logger: loggerMock.create(),
      settings: {},
    },
    { closeReasonOwners, hasAlertStatusChangedListeners }
  );

it('routes close reasons to their native owner and preserves Main rejection for other owners', async () => {
  const validate = jest.fn().mockResolvedValue(true);
  const extensions = restore([
    {
      closeReasonOwners: ['securitySolution'],
      create: () => ({ closeReasonValidators: { securitySolution: validate } }),
    },
  ]);
  expect(extensions.getParityError()).toBeUndefined();
  const request = httpServerMock.createKibanaRequest();
  expect(await extensions.closeReasonValidator?.('custom', 'securitySolution', request)).toBe(true);
  expect(validate).toHaveBeenCalledWith('custom', request);
  expect(await extensions.closeReasonValidator?.('custom', 'observability', request)).toBe(false);
});

it('restores only the solution registrations Main selected', () => {
  const create = jest.fn();
  const extensions = restore([{ closeReasonOwners: ['disabled-owner'], create }], []);
  expect(create).not.toHaveBeenCalled();
  expect(extensions.closeReasonValidator).toBeUndefined();
  expect(extensions.getParityError()).toBeUndefined();
});

it('rejects duplicate and undeclared owner validators', () => {
  const contribution: CasesClientContribution = {
    closeReasonOwners: ['securitySolution'],
    create: () => ({ closeReasonValidators: { securitySolution: async () => true } }),
  };
  expect(() => restore([contribution, contribution])).toThrow(
    'Duplicate Cases close reason validator'
  );
  expect(() =>
    restore([
      {
        ...contribution,
        create: () => ({ closeReasonValidators: { unexpected: async () => true } }),
      },
    ])
  ).toThrow('Undeclared Cases close reason validator');
});

it('reports missing listeners and owner registrations before mutations', () => {
  expect(restore([]).getParityError()).toContain('missing [securitySolution]');
  expect(restore([], [], true).getParityError()).toBe(
    'Cases alert status listeners differ from Main'
  );
});
