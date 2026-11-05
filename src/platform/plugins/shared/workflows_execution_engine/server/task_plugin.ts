/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { PluginType } from '@kbn/core-base-common';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';

/**
 * The execution engine as a plugin of a task process, under the id of the real plugin: Core scopes
 * what plugins register (such as the service account workload types) by plugin id. For now it only
 * holds that place; the runtime a run uses is built by the task module from its host, which is what
 * has the services the engine needs (task scheduling, the license, feature flags, telemetry) that
 * Core's start contract does not.
 */
export const createWorkflowsEngineTaskPlugin = (kibanaVersion: string): StaticPlugin => ({
  manifest: {
    id: 'workflowsExecutionEngine',
    version: kibanaVersion,
    kibanaVersion,
    type: PluginType.standard,
    configPath: ['workflowsExecutionEngine'],
    requiredPlugins: [],
    optionalPlugins: [],
    requiredBundles: [],
    runtimePluginDependencies: [],
    server: true,
    ui: false,
    owner: { name: 'Workflows', githubTeam: 'workflows-eng' },
  },
  definition: {
    plugin: (async () => ({
      setup() {},
      start() {
        return {};
      },
    })) as never,
  },
});
