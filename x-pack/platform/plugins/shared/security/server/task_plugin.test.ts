/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { setTaskProcessContext } from '@kbn/task-manager-plugin/server/task_process/context';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';

import { ConfigSchema, createConfig } from './config';
import { createSecurityTaskPlugin, getTaskProcessSettings } from './task_plugin';

const KIBANA_VERSION = '9.5.0';

const buildSettings = (uiam?: Record<string, unknown>) => {
  const config = createConfig(
    ConfigSchema.validate(
      { audit: { enabled: false }, ...(uiam ? { uiam } : {}) },
      { serverless: !!uiam }
    ),
    loggingSystemMock.create().get(),
    { isTLSEnabled: false }
  );
  return getTaskProcessSettings({
    config,
    applicationName: 'kibana-.kibana',
    kibanaServerResourceURL: 'https://kibana.test',
    elasticsearchUrl: 'https://es.test',
  });
};

const startContext = (settings: unknown) =>
  setTaskProcessContext({
    init: { settings: { security: serializeSettings(settings) } } as never,
    module: {} as never,
    contributions: {},
    definitions: new Map(),
  });

const initializerContext = () => {
  const context = coreMock.createPluginInitializerContext();
  return context;
};

describe('the security task plugin', () => {
  const staticPlugin = createSecurityTaskPlugin(KIBANA_VERSION);

  it('is the security plugin of a process that depends on nothing', () => {
    expect(staticPlugin.manifest).toEqual(
      expect.objectContaining({
        id: 'security',
        configPath: ['xpack', 'security'],
        requiredPlugins: [],
        optionalPlugins: [],
      })
    );
  });

  describe('config', () => {
    const schema = staticPlugin.definition.config!.schema;

    it('accepts what Core sends: the uiam settings and unknown keys', () => {
      expect(
        schema.validate({
          uiam: { enabled: true, sharedSecret: 'secret', url: 'https://uiam.test', ssl: {} },
          other: 1,
        })
      ).toEqual(expect.objectContaining({ uiam: expect.objectContaining({ enabled: true }) }));
      expect(schema.validate({})).toEqual({});
    });

    it('rejects malformed uiam settings', () => {
      expect(() => schema.validate({ uiam: { enabled: 'yes' } })).toThrow();
    });
  });

  describe('settings', () => {
    it('are serializable', () => {
      expect(() => serializeSettings(buildSettings())).not.toThrow();
      expect(serializeSettings(buildSettings())).toEqual(
        expect.objectContaining({ applicationName: 'kibana-.kibana' })
      );
    });

    it('carry the UIAM settings, with durations revived', () => {
      const settings = buildSettings({
        enabled: true,
        url: 'https://uiam.test',
        sharedSecret: 'secret',
        unsafe: { grantedApiKeyDefaultExpiration: '1h' },
      });
      const serialized = serializeSettings(settings) as any;
      expect(serialized.uiam.unsafe.grantedApiKeyDefaultExpiration).toEqual({
        __kind: 'duration',
        ms: 3600000,
      });
    });
  });

  describe('lifecycle', () => {
    const boot = async (settings: unknown) => {
      startContext(settings);
      const instance = await staticPlugin.definition.plugin!(initializerContext());
      const setup = coreMock.createSetup();
      (instance as any).setup(setup);
      const start = coreMock.createStart();
      const contract = (instance as any).start(start);
      return { setup, start, contract };
    };

    it('registers the security delegate with Core', async () => {
      const { setup } = await boot(buildSettings());

      expect(setup.security.registerSecurityDelegate).toHaveBeenCalledTimes(1);
      const delegate = setup.security.registerSecurityDelegate.mock.calls[0][0];
      expect(delegate.authc.apiKeys.uiam).toBeNull();
      expect(delegate.audit.withoutRequest.enabled).toBe(false);
      expect(typeof delegate.fakeRequestEnricher).toBe('function');
    });

    it('serves API keys through the delegate once Core has started', async () => {
      const { setup } = await boot(buildSettings());
      const delegate = setup.security.registerSecurityDelegate.mock.calls[0][0];

      // The license is the one Kibana sent: none was, so security is not available to the run.
      expect(await delegate.authc.apiKeys.areAPIKeysEnabled()).toBe(false);
    });

    it('returns the authc, authz and audit contracts for modules', async () => {
      const { contract } = await boot(buildSettings());

      expect(Object.keys(contract).sort()).toEqual(['audit', 'authc', 'authz']);
      expect(contract.authc.apiKeys.uiam).toBeNull();
      expect(contract.authz.checkPrivilegesWithRequest).toEqual(expect.any(Function));
    });

    it('fails clearly when the process was not given the security settings', async () => {
      setTaskProcessContext({
        init: { settings: {} } as never,
        module: {} as never,
        contributions: {},
        definitions: new Map(),
      });
      await expect(staticPlugin.definition.plugin!(initializerContext())).rejects.toThrow(
        'The task process was not given the settings of: security'
      );
    });
  });
});
