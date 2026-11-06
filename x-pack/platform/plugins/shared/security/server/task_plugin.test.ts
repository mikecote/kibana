/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { setTaskProcessContext } from '@kbn/task-manager-plugin/server/task_process/context';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';

import { ConfigSchema, createConfig } from './config';
import { SERVICE_ACCOUNT_WORKLOAD_BINDING_TYPE } from './service_accounts/bindings';
import { SERVICE_ACCOUNT_CREDENTIAL_TYPE } from './service_accounts/credentials';
import { createSecurityTaskPlugin, getTaskProcessSettings } from './task_plugin';

const KIBANA_VERSION = '9.5.0';

const buildSettings = (
  uiam?: Record<string, unknown>,
  extra: { serviceAccounts?: Record<string, unknown>; cloudProjectContext?: any } = {}
) => {
  const config = createConfig(
    ConfigSchema.validate(
      {
        audit: { enabled: false },
        ...(uiam ? { uiam } : {}),
        ...(extra.serviceAccounts ? { serviceAccounts: extra.serviceAccounts } : {}),
      },
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
    cloudProjectContext: extra.cloudProjectContext,
  });
};

const startContext = (settings: unknown) =>
  setTaskProcessContext({
    init: { settings: { security: serializeSettings(settings) } } as never,
    module: {} as never,
    contributions: {},
    definitions: new Map(),
    flushers: [],
  });

const initializerContext = () => {
  const context = coreMock.createPluginInitializerContext();
  return context;
};

describe('the security task plugin', () => {
  const staticPlugin = createSecurityTaskPlugin(KIBANA_VERSION);

  it('is the security plugin of a process that needs nothing but may use encrypted saved objects', () => {
    expect(staticPlugin.manifest).toEqual(
      expect.objectContaining({
        id: 'security',
        configPath: ['xpack', 'security'],
        requiredPlugins: [],
        optionalPlugins: ['encryptedSavedObjects'],
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

  describe('the service accounts and UIAM settings', () => {
    it('carry the request lifetime and the cloud project context', () => {
      const cloudProjectContext = {
        organizationId: 'org',
        projectId: 'project',
        projectType: 'security',
      };
      const serialized = serializeSettings(
        buildSettings(undefined, {
          serviceAccounts: { requestLifetime: '2m' },
          cloudProjectContext,
        })
      ) as any;
      expect(serialized.serviceAccounts).toEqual({
        enabled: true,
        requestLifetime: { __kind: 'duration', ms: 120000 },
      });
      expect(serialized.cloudProjectContext).toEqual(cloudProjectContext);
    });

    it('carry the contents of the UIAM TLS files and not their paths', () => {
      const dir = mkdtempSync(join(tmpdir(), 'uiam-tls-'));
      writeFileSync(join(dir, 'cert.pem'), 'CERT');
      writeFileSync(join(dir, 'key.pem'), 'KEY');
      writeFileSync(join(dir, 'ca.pem'), 'CA');
      const settings = buildSettings({
        enabled: true,
        url: 'https://uiam.test',
        sharedSecret: 'secret',
        ssl: {
          verificationMode: 'certificate',
          certificate: join(dir, 'cert.pem'),
          key: join(dir, 'key.pem'),
          certificateAuthorities: [join(dir, 'ca.pem')],
        },
      });

      expect(settings.uiamTls).toEqual({
        certificate: 'CERT',
        key: 'KEY',
        certificateAuthorities: ['CA'],
      });
      expect(settings.uiam!.ssl).toEqual({ verificationMode: 'certificate' });
      expect(JSON.stringify(settings)).not.toContain(dir);
    });

    it('send no TLS contents without UIAM', () => {
      expect(buildSettings().uiamTls).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    const boot = async (settings: unknown, { withEso = false }: { withEso?: boolean } = {}) => {
      startContext(settings);
      const instance = await staticPlugin.definition.taskPlugin!(initializerContext());
      const setup = coreMock.createSetup();
      const esoSetup = encryptedSavedObjectsMock.createSetup();
      (instance as any).setup(setup, withEso ? { encryptedSavedObjects: esoSetup } : {});
      const start = coreMock.createStart();
      const contract = (instance as any).start(
        start,
        withEso ? { encryptedSavedObjects: encryptedSavedObjectsMock.createStart() } : {}
      );
      return { setup, start, contract, esoSetup };
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

      expect(Object.keys(contract).sort()).toEqual(['audit', 'authc', 'authz', 'serviceAccounts']);
      expect(contract.serviceAccounts).toBeNull();
      expect(contract.authc.apiKeys.uiam).toBeNull();
      expect(contract.authz.checkPrivilegesWithRequest).toEqual(expect.any(Function));
    });

    describe('service accounts', () => {
      it('registers their two hidden saved object types and encrypted registrations', async () => {
        const { setup, esoSetup } = await boot(buildSettings(), { withEso: true });

        const types = setup.savedObjects.registerType.mock.calls.map(([type]) => type);
        expect(types.map(({ name }) => name).sort()).toEqual(
          [SERVICE_ACCOUNT_CREDENTIAL_TYPE, SERVICE_ACCOUNT_WORKLOAD_BINDING_TYPE].sort()
        );
        expect(types.every(({ hidden }) => hidden)).toBe(true);
        expect(esoSetup.registerType.mock.calls.map(([{ type }]) => type).sort()).toEqual(
          [SERVICE_ACCOUNT_CREDENTIAL_TYPE, SERVICE_ACCOUNT_WORKLOAD_BINDING_TYPE].sort()
        );
      });

      it('serves them from the real service and reports them enabled through the delegate', async () => {
        const { setup, contract } = await boot(buildSettings(), { withEso: true });

        expect(contract.serviceAccounts).not.toBeNull();
        expect(contract.serviceAccounts.backend).toBeDefined();
        expect(contract.serviceAccounts.workloads.withScopedRequest).toEqual(expect.any(Function));
        const delegate = setup.security.registerSecurityDelegate.mock.calls[0][0];
        expect(delegate.serviceAccounts.isEnabled()).toBe(true);
      });

      it('offers none when they are disabled', async () => {
        const { setup, contract } = await boot(
          buildSettings(undefined, { serviceAccounts: { enabled: false } }),
          { withEso: true }
        );

        expect(contract.serviceAccounts).toBeNull();
        const delegate = setup.security.registerSecurityDelegate.mock.calls[0][0];
        expect(delegate.serviceAccounts.isEnabled()).toBe(false);
      });

      it('offers none without the encrypted saved objects plugin, and registers no types', async () => {
        const { setup, contract } = await boot(buildSettings());

        expect(contract.serviceAccounts).toBeNull();
        expect(setup.savedObjects.registerType).not.toHaveBeenCalledWith(
          expect.objectContaining({ name: SERVICE_ACCOUNT_CREDENTIAL_TYPE })
        );
        const delegate = setup.security.registerSecurityDelegate.mock.calls[0][0];
        expect(delegate.serviceAccounts.isEnabled()).toBe(false);
      });
    });

    it('fails clearly when the process was not given the security settings', async () => {
      setTaskProcessContext({
        init: { settings: {} } as never,
        module: {} as never,
        contributions: {},
        definitions: new Map(),
        flushers: [],
      });
      await expect(staticPlugin.definition.taskPlugin!(initializerContext())).rejects.toThrow(
        'The task process was not given the settings of: security'
      );
    });
  });
});
