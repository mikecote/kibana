/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { connectorsSpecs } from '@kbn/connector-specs';
import { registerConnectorTypesForRuleRuns } from './register_connector_types_for_rule_runs';

describe('registerConnectorTypesForRuleRuns', () => {
  it('registers the connector types of the plugin, and no sub action framework is needed to list them', () => {
    const registerType = jest.fn();
    const registerSubActionConnectorType = jest.fn();
    registerConnectorTypesForRuleRuns(
      {
        registerType,
        registerSubActionConnectorType,
        getClientLeasePool: jest.fn(),
        getActionsConfigurationUtilities: jest.fn().mockReturnValue({
          getAwsSesConfig: jest.fn(),
          isInboundEventsEnabled: () => true,
          isConnectorSigningKeysEnabled: () => true,
        }),
      } as never,
      { publicBaseUrl: 'https://kibana.test' }
    );

    const ids = registerType.mock.calls.map(([type]) => type.id);
    expect(ids).toEqual(
      expect.arrayContaining(['.email', '.index', '.server-log', '.slack', '.webhook'])
    );
    expect(registerSubActionConnectorType).toHaveBeenCalled();
  });

  it('registers the connector types the specs define, as the plugin does', () => {
    const registerType = jest.fn();
    registerConnectorTypesForRuleRuns({
      registerType,
      registerSubActionConnectorType: jest.fn(),
      getClientLeasePool: jest.fn(),
      getActionsConfigurationUtilities: jest.fn().mockReturnValue({
        getAwsSesConfig: jest.fn(),
        isInboundEventsEnabled: () => true,
        isConnectorSigningKeysEnabled: () => true,
      }),
    } as never);

    const ids = registerType.mock.calls.map(([type]) => type.id);
    const specIds = Object.values(connectorsSpecs).map((spec) => spec.metadata.id);
    expect(specIds.length).toBeGreaterThan(10);
    expect(ids).toEqual(expect.arrayContaining(specIds));
  });
});
