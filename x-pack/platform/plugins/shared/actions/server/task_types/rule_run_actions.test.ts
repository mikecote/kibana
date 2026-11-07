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
import type { ActionType, InMemoryConnector } from '../types';
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
  const create = (config = {}, extra: Partial<Parameters<typeof createRuleRunActions>[0]> = {}) =>
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
      ...extra,
    });

  it('knows the connector types that were registered, and no others', () => {
    const { hasActionType, stop } = create();
    expect(hasActionType('.server-log')).toBe(true);
    expect(hasActionType('.unknown')).toBe(false);
    stop();
  });

  it('exposes the same host restrictions and relay configuration to workflow tools', () => {
    const { actionsPlugin, stop } = create({
      allowedHosts: ['allowed.example'],
      relay: { url: 'https://relay.example' },
    });
    const config = actionsPlugin.getActionsConfigurationUtilities();
    expect(config.isHostnameAllowed('allowed.example')).toBe(true);
    expect(config.isHostnameAllowed('other.example')).toBe(false);
    expect(actionsPlugin.getRelayClient()?.uiamEnabled).toBe(false);
    stop();
  });

  it('answers whether an action is executable from the registry and the license', () => {
    const { actionsPlugin, stop } = create();
    expect(actionsPlugin.isActionExecutable('connector-1', '.server-log')).toBe(true);
    stop();
  });

  it('records the use of a licensed connector type with the feature usage it is given', () => {
    const notifyUsage = jest.fn();
    const { actionsPlugin, stop } = create(
      {},
      {
        featureUsage: { notifyUsage },
        registerConnectorTypes: (actions) =>
          actions.registerType({ ...connectorType, minimumLicenseRequired: 'gold' }),
      }
    );

    actionsPlugin.isActionExecutable('connector-1', '.server-log', { notifyUsage: true });

    expect(notifyUsage).toHaveBeenCalledWith('Connector: Test');
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

  describe('the in-memory connectors Kibana sent', () => {
    const dynamic: InMemoryConnector = {
      id: 'elastic-apps-slack',
      name: 'Elastic apps',
      actionTypeId: '.server-log',
      config: {},
      secrets: {},
      isPreconfigured: true,
      isDeprecated: false,
      isConnectorTypeDeprecated: false,
      isSystemAction: false,
      isDynamic: true,
    };

    it('uses a connector another plugin registered in Kibana, which the config does not have', () => {
      // `.server-log` is not enabled, so only a preconfigured connector may use it.
      const config = { enabledActionTypes: ['.index'] };
      const fromConfig = create(config);
      expect(fromConfig.actionsPlugin.isActionExecutable('elastic-apps-slack', '.server-log')).toBe(
        false
      );
      fromConfig.stop();

      const sent = create(config, { inMemoryConnectors: [dynamic] });
      expect(sent.actionsPlugin.isActionExecutable('elastic-apps-slack', '.server-log')).toBe(true);
      expect(sent.actionsPlugin.isActionExecutable('another', '.server-log')).toBe(false);
      sent.stop();
    });

    it('takes the list as it is: neither the config nor the system actions are added to it', () => {
      const { actionsPlugin, stop } = create(
        { preconfigured: { 'my-log': { name: 'log', actionTypeId: '.server-log' } } },
        { inMemoryConnectors: [{ ...dynamic, isSystemAction: true, isPreconfigured: false }] }
      );
      expect(actionsPlugin.isSystemActionConnector('elastic-apps-slack')).toBe(true);
      expect(actionsPlugin.isActionExecutable('my-log', '.server-log')).toBe(true);
      stop();
    });

    it('does not change the list it was given when it registers connector types', () => {
      const sent = [dynamic];
      create({}, { inMemoryConnectors: sent }).stop();
      expect(sent).toEqual([dynamic]);
    });
  });

  it('lists the ids of the connector types it registered', () => {
    const { getActionTypeIds, stop } = create();
    expect(getActionTypeIds()).toEqual(['.server-log']);
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

  describe('the privileges of the connector, checked when a run enqueues it', () => {
    const authorization = (hasAllRequested: boolean) =>
      ({
        mode: { useRbacForRequest: () => true },
        actions: {
          savedObject: { get: (type: string, operation: string) => `${type}:${operation}` },
        },
        checkPrivilegesDynamicallyWithRequest: () => async () => ({ hasAllRequested }),
      } as never);
    const request = { headers: {}, spaceId: 'default' } as never;
    const actions = [{ id: 'connector-1', params: {}, spaceId: 'default', apiKey: null }] as never;

    it('refuses a user who may not execute connectors', async () => {
      const { actionsPlugin, stop } = create({}, { authorization: authorization(false) });
      const client = await actionsPlugin.getActionsClientWithRequest(request);
      await expect(client.bulkEnqueueExecution(actions)).rejects.toThrow(
        'Unauthorized to execute actions'
      );
      stop();
    });

    it('does not refuse a user who may', async () => {
      const { actionsPlugin, stop } = create({}, { authorization: authorization(true) });
      const client = await actionsPlugin.getActionsClientWithRequest(request);
      await expect(client.bulkEnqueueExecution(actions)).rejects.not.toThrow(
        'Unauthorized to execute actions'
      );
      stop();
    });
  });
});
