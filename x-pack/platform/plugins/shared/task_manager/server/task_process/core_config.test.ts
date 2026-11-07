/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { buildCoreConfig } from './core_config';
import type { TaskProcessInit } from './wire';

const init = (extra: Partial<TaskProcessInit> = {}): TaskProcessInit => ({
  kind: 'init',
  elasticsearch: {
    hosts: ['http://es:9200'],
    customHeaders: {},
    requestHeadersWhitelist: ['authorization'],
    maxSockets: 1,
    maxIdleSockets: 1,
    idleSocketTimeoutMs: 1,
    dnsCacheTtlMs: 1,
    requestTimeoutMs: 1,
    sniffIntervalMs: false,
    sniffOnStart: false,
    sniffOnConnectionFault: false,
    compression: false,
    ssl: { verificationMode: 'full' },
  } as never,
  kibanaVersion: '9.9.9',
  authToken: 't',
  ...extra,
});

interface Logging {
  appenders: { console: { layout: { type: string } } };
}

describe('buildCoreConfig', () => {
  it('enables native UI settings for config-dependent registration hooks', () => {
    const { settings, cleanup } = buildCoreConfig(init(), { registerUiSettings: () => {} });
    expect(settings.uiSettings).toEqual({ overrides: {}, globalOverrides: {} });
    cleanup();
  });

  it('configures native encryption for saved object migration factories without encrypted declarations', () => {
    const encryptionKey = 'k'.repeat(32);
    const { settings, cleanup } = buildCoreConfig(
      init({ encryptedSavedObjects: { encryptionKey, decryptionOnlyKeys: [] } }),
      { createSavedObjectTypes: () => [] }
    );
    expect(settings.xpack).toEqual({
      encryptedSavedObjects: { encryptionKey, keyRotation: { decryptionOnlyKeys: [] } },
    });
    cleanup();
  });

  it('disables eager data stream installation and migrations in task workers', () => {
    const { settings, cleanup } = buildCoreConfig(init(), {});
    expect(settings.dataStreams).toEqual({ migrations: { skip: true } });
    cleanup();
  });

  it.each([false, true])(
    'preserves Core FIPS mode alongside UIAM authentication (enabled: %s)',
    (enabled) => {
      const uiam = { enabled: true, sharedSecret: 'test-secret' };
      const { settings, cleanup } = buildCoreConfig(
        init({
          settings: {
            security: { fipsMode: { enabled }, uiam },
          },
        }),
        {}
      );
      expect(settings.xpack).toEqual({ security: { fipsMode: { enabled }, uiam } });
      cleanup();
    }
  );

  it('gives Core the ui settings overrides and global overrides Kibana has', () => {
    const { settings, cleanup } = buildCoreConfig(
      init({
        uiSettingsOverrides: { 'dateFormat:tz': 'UTC' },
        uiSettingsGlobalOverrides: { 'contextEngine:feedbackLoop': true },
      }),
      {}
    );
    expect(settings.uiSettings).toEqual({
      overrides: { 'dateFormat:tz': 'UTC' },
      globalOverrides: { 'contextEngine:feedbackLoop': true },
    });
    cleanup();
  });

  it('sets none when Kibana has none and the module reads no ui settings', () => {
    const { settings, cleanup } = buildCoreConfig(init(), {});
    expect(settings).not.toHaveProperty('uiSettings');
    cleanup();
  });

  it("has no public base URL when Kibana has none, and Kibana's own when it has", () => {
    const none = buildCoreConfig(
      init({ server: { uuid: 'u', buildNum: 1, isServerless: false } }),
      {}
    );
    expect((none.settings.server as Record<string, unknown>).publicBaseUrl).toBeUndefined();
    none.cleanup();
    const some = buildCoreConfig(
      init({
        server: {
          uuid: 'u',
          buildNum: 1,
          isServerless: false,
          publicBaseUrl: 'https://kibana.example.com/kbn',
        },
      }),
      {}
    );
    expect((some.settings.server as Record<string, unknown>).publicBaseUrl).toBe(
      'https://kibana.example.com/kbn'
    );
    some.cleanup();
    // Core refuses a public base URL with a path that does not contain the base path.
    const withBasePath = buildCoreConfig(
      init({
        server: {
          uuid: 'u',
          buildNum: 1,
          isServerless: false,
          publicBaseUrl: 'https://kibana.example.com/kbn',
          basePath: '/kbn',
        },
      }),
      {}
    );
    expect((withBasePath.settings.server as Record<string, unknown>).basePath).toBe('/kbn');
    withBasePath.cleanup();
  });

  it("writes Kibana's JSON layout when Kibana forked the process", () => {
    const layoutOf = () =>
      ((some.settings.logging as Logging).appenders.console.layout as { type: string }).type;
    const some = buildCoreConfig(init(), {});
    expect(layoutOf()).toBe('pattern');
    some.cleanup();
    process.env.TASK_PROCESS_LOG_LAYOUT = 'json';
    try {
      const forked = buildCoreConfig(init(), {});
      expect((forked.settings.logging as Logging).appenders.console.layout.type).toBe('json');
      expect((forked.settings.logging as { loggers: unknown }).loggers).toEqual([
        { name: 'status', level: 'off' },
      ]);
      forked.cleanup();
    } finally {
      delete process.env.TASK_PROCESS_LOG_LAYOUT;
    }
  });
});
