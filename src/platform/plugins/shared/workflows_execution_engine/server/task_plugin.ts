/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CoreSetup } from '@kbn/core/server';
import { PluginType } from '@kbn/core-base-common';
import type { StaticPlugin } from '@kbn/core-plugins-server-internal';

import { WORKFLOW_SERVICE_ACCOUNT_TYPE } from './service_account_execution';

/** The name of the workflow workload type, which the plugin and a task process register alike. */
export const WORKFLOW_WORKLOAD_TYPE_NAME = 'Workflow';

/**
 * The execution engine as a plugin of a task process, under the id of the real plugin: Core scopes
 * what plugins register (such as the service account workload types) by plugin id. It registers the
 * `workflow` workload type as the plugin does in Kibana, so that the process's service accounts know the
 * workloads a run is bound to (what lists and resolves them is Kibana's). The runtime a run uses is built by the task module from its host, which is what
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
      setup(core: CoreSetup) {
        core.security.serviceAccounts.registerWorkloadType({
          type: WORKFLOW_SERVICE_ACCOUNT_TYPE,
          name: WORKFLOW_WORKLOAD_TYPE_NAME,
        });
      },
      start() {
        return {};
      },
    })) as never,
  },
});
