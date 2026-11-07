/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// A task process writes the certificates of Kibana's Elasticsearch connection to a private temporary
// directory that it removes when it exits, which is not what `@kbn/fs` volumes are for.
// eslint-disable-next-line @kbn/eslint/require_kbn_fs
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TaskTypeModule } from '../task_type_module';
import type { SerializedElasticsearchConfig } from './es_config';
import { reviveSettingsByPlugin } from './settings';
import type { TaskProcessInit } from './wire';

export interface CoreConfig {
  /** The raw settings Core validates, as a `kibana.yml` would hold them. */
  settings: Record<string, unknown>;
  /** Removes the files the settings point at: certificates, keys and the data directory. */
  cleanup: () => void;
}

/**
 * Core's Elasticsearch settings, from the parsed connection Kibana sent. Core's own schema reads
 * certificates from files and Kibana only has their contents, so each goes to a private file that
 * lives as long as the process.
 */
const toElasticsearchSettings = (
  es: SerializedElasticsearchConfig,
  secretsDir: string
): Record<string, unknown> => {
  const write = (name: string, contents: string) => {
    const file = join(secretsDir, name);
    writeFileSync(file, contents, { mode: 0o600 });
    return file;
  };
  const { ssl } = es;
  return {
    hosts: es.hosts,
    ...(es.username ? { username: es.username } : {}),
    ...(es.password ? { password: es.password } : {}),
    ...(es.serviceAccountToken ? { serviceAccountToken: es.serviceAccountToken } : {}),
    customHeaders: es.customHeaders,
    requestHeadersWhitelist: es.requestHeadersWhitelist,
    maxSockets: es.maxSockets,
    maxIdleSockets: es.maxIdleSockets,
    ...(es.maxResponseSizeBytes !== undefined ? { maxResponseSize: es.maxResponseSizeBytes } : {}),
    idleSocketTimeout: es.idleSocketTimeoutMs,
    dnsCacheTtl: es.dnsCacheTtlMs,
    requestTimeout: es.requestTimeoutMs,
    sniffInterval: es.sniffIntervalMs,
    sniffOnStart: es.sniffOnStart,
    sniffOnConnectionFault: es.sniffOnConnectionFault,
    compression: es.compression,
    ...(es.apisToRedactInLogs ? { apisToRedactInLogs: es.apisToRedactInLogs } : {}),
    ssl: {
      verificationMode: ssl.verificationMode,
      ...(ssl.alwaysPresentCertificate !== undefined
        ? { alwaysPresentCertificate: ssl.alwaysPresentCertificate }
        : {}),
      ...(ssl.certificateAuthorities?.length
        ? {
            certificateAuthorities: ssl.certificateAuthorities.map((ca, i) =>
              write(`ca-${i}.pem`, ca)
            ),
          }
        : {}),
      ...(ssl.certificate ? { certificate: write('certificate.pem', ssl.certificate) } : {}),
      ...(ssl.key ? { key: write('key.pem', ssl.key) } : {}),
      ...(ssl.keyPassphrase ? { keyPassphrase: ssl.keyPassphrase } : {}),
    },
  };
};

/**
 * The settings Core boots a task process with: the same schemas as Kibana validate them, so a
 * process that boots has a valid configuration. Only what a run needs is set, and everything that
 * would make the process a server is off: it does not listen, migrate saved objects or scan for
 * plugins and translations.
 */
export const buildCoreConfig = (
  init: TaskProcessInit,
  module: Pick<
    TaskTypeModule,
    | 'uiSettings'
    | 'registerUiSettings'
    | 'encryptedSavedObjectTypes'
    | 'createSavedObjectTypes'
    | 'taskManager'
  >
): CoreConfig => {
  const dir = mkdtempSync(join(tmpdir(), 'kbn-task-process-'));
  // Core rejects encryption config unless the module needs encrypted types or native migrations.
  const keys =
    module.encryptedSavedObjectTypes?.length || module.createSavedObjectTypes || module.taskManager
      ? init.encryptedSavedObjects
      : undefined;
  // Core reads the UIAM client authentication of Elasticsearch requests from `xpack.security.uiam`,
  // so the settings the security plugin registers for task processes carry it.
  const { uiam, fipsMode } =
    (reviveSettingsByPlugin(init.settings).security as
      | { uiam?: unknown; fipsMode?: { enabled: boolean } }
      | undefined) ?? {};
  const settings: Record<string, unknown> = {
    core: { lifecycle: { disablePreboot: true } },
    elasticsearch: toElasticsearchSettings(init.elasticsearch, dir),
    path: { data: join(dir, 'data') },
    server: {
      autoListen: false,
      port: 0,
      ...(init.server?.uuid ? { uuid: init.server.uuid } : {}),
      ...(init.server?.basePath ? { basePath: init.server.basePath } : {}),
      // Core's self client calls Kibana at this URL; what a run builds links with is `host.server`.
      ...(init.server?.kibanaUrl ?? init.server?.publicBaseUrl
        ? { publicBaseUrl: init.server?.kibanaUrl ?? init.server?.publicBaseUrl }
        : {}),
    },
    // Kibana owns startup migrations; runs retain native lazy initialization of their declared storage.
    migrations: { skip: true },
    dataStreams: { migrations: { skip: true } },
    plugins: { initialize: true },
    // No translation files: nothing in a run is rendered for a person.
    i18n: { locales: [] },
    // A forked process writes Kibana's JSON layout, which Kibana reads and logs with its own logger;
    // a remote process, which nobody reads for, keeps the readable pattern.
    logging: {
      appenders: {
        console: {
          type: 'console',
          layout: { type: process.env.TASK_PROCESS_LOG_LAYOUT === 'json' ? 'json' : 'pattern' },
        },
      },
      root: { appenders: ['console'], level: process.env.TASK_PROCESS_LOG_LEVEL ?? 'warn' },
      // Services report themselves unavailable while they start (the security plugin's status at
      // error), which Kibana already logs for itself; a process that lives for one run says it every run.
      loggers: [{ name: 'status', level: 'off' }],
    },
    ...(init.uiSettingsOverrides ||
    init.uiSettingsGlobalOverrides ||
    module.uiSettings ||
    module.registerUiSettings
      ? {
          uiSettings: {
            overrides: init.uiSettingsOverrides ?? {},
            globalOverrides: init.uiSettingsGlobalOverrides ?? {},
          },
        }
      : {}),
    ...(keys || uiam || fipsMode
      ? {
          xpack: {
            ...(keys
              ? {
                  encryptedSavedObjects: {
                    ...(keys.encryptionKey ? { encryptionKey: keys.encryptionKey } : {}),
                    keyRotation: { decryptionOnlyKeys: keys.decryptionOnlyKeys },
                  },
                }
              : {}),
            ...(uiam || fipsMode
              ? { security: { ...(uiam ? { uiam } : {}), ...(fipsMode ? { fipsMode } : {}) } }
              : {}),
          },
        }
      : {}),
  };
  return {
    settings,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};
