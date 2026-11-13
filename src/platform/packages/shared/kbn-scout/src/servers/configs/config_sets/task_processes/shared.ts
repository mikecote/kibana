/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import { CA_CERT_PATH } from '@kbn/dev-utils';
import { getRemoteManifestPaths } from '@kbn/repo-packages';
import { interpretRemoteManifest } from '@kbn/import-locator';
import type { ScoutServerConfig } from '../../../../types';
import { servers as defaultConfig } from '../default/stateful/classic.stateful.config';

/** Where the task process bundles of this config set are built. */
export const TASK_PROCESSES_DIR = resolve(REPO_ROOT, 'target', 'task_processes_scout');
export const TASK_PROCESSES_BUNDLE_DIR = resolve(TASK_PROCESSES_DIR, 'bundles');
/** Kibana's log, as JSON records, which the tests read to see where a run happened. */
export const TASK_PROCESSES_LOG_FILE = resolve(TASK_PROCESSES_DIR, 'kibana.log');
/** The task process cap of this config set, which the concurrency test relies on. */
export const TASK_PROCESSES_MAX_CONCURRENT = 2;

/** Every registered module needs a real bundle when Main is configured for process execution. */
const BUNDLES = getRemoteManifestPaths(REPO_ROOT).flatMap(({ pluginId, path }) =>
  (interpretRemoteManifest(path).taskTypes ?? []).map(
    ({ modulePath }) => `${pluginId}__${basename(modulePath).replace(/\.task\.[jt]s$/, '')}`
  )
);

/**
 * Kibana reads the manifest of the bundles when it starts, so they are built when the config is
 * loaded, once (`TASK_PROCESSES_REBUILD=true` builds them again).
 */
export const ensureTaskBundles = () => {
  const manifestFile = resolve(TASK_PROCESSES_BUNDLE_DIR, 'manifest.json');
  if (existsSync(manifestFile) && process.env.TASK_PROCESSES_REBUILD !== 'true') {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      bundles: Record<string, { file: string }>;
    };
    if (
      BUNDLES.every(
        (name) =>
          manifest.bundles[name] &&
          existsSync(resolve(TASK_PROCESSES_BUNDLE_DIR, manifest.bundles[name].file))
      )
    )
      return;
  }
  mkdirSync(TASK_PROCESSES_BUNDLE_DIR, { recursive: true });
  execFileSync(
    process.execPath,
    ['scripts/task_bundle', '--out', TASK_PROCESSES_BUNDLE_DIR, '--manifest'],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
};

ensureTaskBundles();

// Its own ports, so it can run next to the servers of another config set.
const ES_PORT = 9640;
const KBN_PORT = 5640;
const withPorts = (arg: string) =>
  arg.replace(/([:=])5620\b/g, `$1${KBN_PORT}`).replace(/([:=])9220\b/g, `$1${ES_PORT}`);

/** The loggers of the default config, and Task Manager at debug so the log says where each run was. */
const loggers = [
  { name: 'elasticsearch.deprecation', level: 'all', appenders: ['deprecation'] },
  { name: 'plugins.taskManager', level: 'debug', appenders: ['default', 'task_processes_file'] },
  // The output of the server log connector, which runs in Kibana
  { name: 'plugins.actions', level: 'info', appenders: ['default', 'task_processes_file'] },
];

/**
 * Task Manager runs the rule types that are task type modules in a process of their own
 * (`xpack.task_manager.task_execution.mode: child_process`), so the tests prove it in a real Kibana.
 */
export const createTaskProcessesServers = (
  extraServerArgs: string[] = [],
  baseConfig: ScoutServerConfig = defaultConfig
): ScoutServerConfig => ({
  ...baseConfig,
  http2: true,
  servers: {
    elasticsearch: { ...baseConfig.servers.elasticsearch, port: ES_PORT },
    kibana: { ...baseConfig.servers.kibana, port: KBN_PORT, pathname: '/task-processes' },
  },
  kbnTestServer: {
    ...baseConfig.kbnTestServer,
    env: {
      ...baseConfig.kbnTestServer.env,
      NODE_TLS_REJECT_UNAUTHORIZED: '1',
    },
    serverArgs: [
      ...baseConfig.kbnTestServer.serverArgs.map(withPorts),
      '--server.basePath=/task-processes',
      '--server.rewriteBasePath=true',
      `--server.publicBaseUrl=https://localhost:${KBN_PORT}/task-processes`,
      `--server.selfHttp.ssl.certificateAuthorities=${CA_CERT_PATH}`,
      '--feature_flags.overrides.workflows.kibanaRequest.coreSelfClientEnabled=true',
      '--xpack.task_manager.task_execution.mode=child_process',
      `--xpack.task_manager.task_execution.bundle_dir=${TASK_PROCESSES_BUNDLE_DIR}`,
      `--xpack.task_manager.task_execution.max_concurrent_processes=${TASK_PROCESSES_MAX_CONCURRENT}`,
      // Lets rules run every second, where the default minimum is a minute
      '--xpack.alerting.rules.minimumScheduleInterval.value=1s',
      // A rule that cannot finish in this time is cancelled, which has to end its process
      `--xpack.alerting.rules.run.ruleTypeOverrides=${JSON.stringify([
        { id: '.index-threshold', timeout: '1s' },
      ])}`,
      `--logging.appenders.task_processes_file=${JSON.stringify({
        type: 'file',
        fileName: TASK_PROCESSES_LOG_FILE,
        layout: { type: 'json' },
      })}`,
      `--logging.loggers=${JSON.stringify(loggers)}`,
      ...extraServerArgs,
    ],
  },
});
