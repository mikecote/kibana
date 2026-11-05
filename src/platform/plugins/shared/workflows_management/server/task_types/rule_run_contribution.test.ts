/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { contribution } from './rule_run_contribution';

describe('the rule run contribution of workflows management', () => {
  it('registers the .workflows system action and its adapter', () => {
    const actions = { registerType: jest.fn() };
    const alerting = { registerConnectorAdapter: jest.fn() };

    contribution.register!({ actions, alerting } as never, {} as never);

    expect(actions.registerType).toHaveBeenCalledWith(
      expect.objectContaining({ id: '.workflows', isSystemActionType: true })
    );
    expect(alerting.registerConnectorAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ connectorTypeId: '.workflows' })
    );
  });
});
