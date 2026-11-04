/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { savedObjectsServiceMock } from '@kbn/core-saved-objects-server-mocks';
import { elasticsearchServiceMock } from '@kbn/core-elasticsearch-server-mocks';
import type { ILicense } from '@kbn/licensing-types';
import type { ActionType } from '../types';
import { configSchema } from '../config';
import { createRuleRunActions } from './rule_run_actions';

const license = {
  isActive: true,
  type: 'platinum',
  check: () => ({ state: 'valid' }),
  hasAtLeast: () => true,
  getFeature: () => ({ isAvailable: true, isEnabled: true }),
  getUnavailableReason: () => undefined,
  isAvailable: true,
} as unknown as ILicense;

const connectorType: ActionType = {
  id: '.server-log',
  name: 'Test',
  minimumLicenseRequired: 'basic',
  supportedFeatureIds: ['alerting'],
  validate: {
    config: { schema: { validate: (value: unknown) => value } as never },
    secrets: { schema: { validate: (value: unknown) => value } as never },
    params: { schema: { validate: (value: unknown) => value } as never },
  },
  executor: jest.fn(),
};

describe('createRuleRunActions', () => {
  const create = (config = {}) =>
    createRuleRunActions({
      logger: loggingSystemMock.createLogger(),
      config: configSchema.validate(config),
      license$: of(license),
      elasticsearch: elasticsearchServiceMock.createStart().client,
      savedObjects: savedObjectsServiceMock.createStartContract(),
      getEncryptedSavedObjectsClient: jest.fn().mockReturnValue({}),
      taskManager: { bulkSchedule: jest.fn(), aggregate: jest.fn() },
      publicBaseUrl: 'https://kibana.test',
      registerConnectorTypes: (actions) => actions.registerType(connectorType),
    });

  it('knows the connector types that were registered, and no others', () => {
    const { hasActionType, stop } = create();
    expect(hasActionType('.server-log')).toBe(true);
    expect(hasActionType('.unknown')).toBe(false);
    stop();
  });

  it('answers whether an action is executable from the registry and the license', () => {
    const { actionsPlugin, stop } = create();
    expect(actionsPlugin.isActionExecutable('connector-1', '.server-log')).toBe(true);
    stop();
  });

  it('knows system connectors from the registered connector types', () => {
    const { actionsPlugin, stop } = create({
      preconfigured: { 'my-log': { name: 'log', actionTypeId: '.server-log' } },
    });
    expect(actionsPlugin.isSystemActionConnector('my-log')).toBe(false);
    expect(actionsPlugin.isSystemActionConnector('nothing')).toBe(false);
    stop();
  });

  it('renders the parameters of an action with mustache when the type has no renderer', () => {
    const { actionsPlugin, stop } = create();
    expect(
      actionsPlugin.renderActionParameterTemplates(
        '.server-log',
        'connector-1',
        { message: 'hi {{name}}' },
        {
          name: 'there',
        }
      )
    ).toEqual({ message: 'hi there' });
    stop();
  });

  it('builds an actions client for a request', async () => {
    const { actionsPlugin, stop } = create();
    const client = await actionsPlugin.getActionsClientWithRequest({
      headers: {},
      spaceId: 'default',
    } as never);
    expect(client.bulkEnqueueExecution).toEqual(expect.any(Function));
    stop();
  });
});
