/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { readFileSync } from 'fs';
import { elasticsearchConfigFromEnv } from './es_config';
import { startTaskProcessServer } from './server';
import { startTaskProcessCore } from './core_process';
import type { TaskProcessInit, TaskProcessReady } from './wire';
import { watchParent } from './parent_watch';
import type { TaskTypeModule } from '../task_type_module';

const PARENT_GONE_STOP_TIMEOUT_MS = 5000;

declare const __KBN_VERSION__: string | undefined;

/**
 * What a remote process takes from its environment besides the Elasticsearch connection:
 * ESO_ENCRYPTION_KEY and ESO_DECRYPTION_ONLY_KEYS (comma separated), KIBANA_SERVER_UUID,
 * KIBANA_BUILD_NUM, KIBANA_PUBLIC_BASE_URL, KIBANA_BASE_PATH, KIBANA_SERVERLESS, and TASK_PROCESS_SETTINGS, the path
 * of a JSON file `{ "settings": { "<pluginId>": <config> }, "uiSettingsOverrides": {}, "uiSettingsGlobalOverrides": {}, "parity": [{ "kind": "...", "ids": [] }] }` whose
 * configs use the format of `serializeSettings` (a duration is `{"__kind":"duration","ms":1000}`).
 */
export const initFromEnv = (env: NodeJS.ProcessEnv = process.env): TaskProcessInit => {
  const file = env.TASK_PROCESS_SETTINGS
    ? (JSON.parse(readFileSync(env.TASK_PROCESS_SETTINGS, 'utf8')) as Pick<
        TaskProcessInit,
        'settings' | 'uiSettingsOverrides' | 'uiSettingsGlobalOverrides' | 'parity'
      >)
    : {};
  return {
    kind: 'init',
    elasticsearch: elasticsearchConfigFromEnv(env),
    kibanaVersion: env.KIBANA_VERSION ?? __KBN_VERSION__ ?? 'unknown',
    authToken: env.TASK_PROCESS_TOKEN ?? '',
    server: {
      uuid: env.KIBANA_SERVER_UUID ?? '',
      buildNum: env.KIBANA_BUILD_NUM ? Number(env.KIBANA_BUILD_NUM) : Number.MAX_SAFE_INTEGER,
      publicBaseUrl: env.KIBANA_PUBLIC_BASE_URL,
      kibanaUrl: env.KIBANA_URL ?? env.KIBANA_PUBLIC_BASE_URL,
      basePath: env.KIBANA_BASE_PATH,
      isServerless: env.KIBANA_SERVERLESS === 'true',
      isDev: env.KIBANA_DEV === 'true',
    },
    encryptedSavedObjects: env.ESO_ENCRYPTION_KEY
      ? {
          encryptionKey: env.ESO_ENCRYPTION_KEY,
          decryptionOnlyKeys: (env.ESO_DECRYPTION_ONLY_KEYS ?? '')
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean),
        }
      : undefined,
    settings: file.settings,
    uiSettingsOverrides: file.uiSettingsOverrides,
    uiSettingsGlobalOverrides: file.uiSettingsGlobalOverrides,
    parity: file.parity,
  };
};

/** Kibana, when it forked this process, sends `init` first; a remote process uses its environment. */
const readInit = (): Promise<TaskProcessInit> => {
  if (process.send) {
    return new Promise<TaskProcessInit>((resolve) => {
      process.on('message', (message: TaskProcessInit) => {
        if (message?.kind === 'init') resolve(message);
      });
    });
  }
  return Promise.resolve(initFromEnv());
};

/**
 * Entry of a task process: Core and the plugins a task type needs, started the way Kibana starts
 * them, serving one task type for Task Manager. Kibana starts it as a child process; an operator can
 * run it as a remote process. Env of a remote process: ES_URL, ES_API_KEY or ES_USERNAME and
 * ES_PASSWORD, PORT, TASK_PROCESS_TOKEN.
 */
export const runTaskProcess = async (
  module: TaskTypeModule,
  { contributions }: { contributions?: Record<string, unknown[]> } = {}
) => {
  // Kibana forked this process: it ends with Kibana, however Kibana ends.
  let stopCore: (() => Promise<void>) | undefined;
  if (process.send) {
    watchParent({
      onParentGone: (reason) => {
        process.stderr.write(`Task process stopping: its parent is gone (${reason})\n`);
        // Closing Core is bounded: nothing is left to wait for a run for.
        const forceExit = setTimeout(() => process.exit(1), PARENT_GONE_STOP_TIMEOUT_MS);
        forceExit.unref();
        (stopCore?.() ?? Promise.resolve()).finally(() => process.exit(0));
      },
    });
  }
  try {
    const init = await readInit();
    const core = await startTaskProcessCore({ init, module, contributions });
    stopCore = core.stop;

    startTaskProcessServer({
      taskDefinitions: core.definitions,
      port: Number(process.env.PORT ?? 0),
      // Only a forked process is Kibana's own; its runs carry credentials, so it is loopback only.
      host: process.send ? '127.0.0.1' : process.env.HOST || undefined,
      logger: core.logger,
      kibanaVersion: init.kibanaVersion,
      authToken: init.authToken || undefined,
      onListening: (port) => {
        if (process.send) {
          process.send({ kind: 'ready', port } satisfies TaskProcessReady);
        } else {
          process.stdout.write(`READY ${port}\n`);
        }
      },
      onShutdown: core.stop,
      flush: core.flush,
    });
  } catch (error) {
    process.stderr.write(`Task process failed to start: ${(error as Error).stack ?? error}\n`);
    process.exit(1);
  }
};
