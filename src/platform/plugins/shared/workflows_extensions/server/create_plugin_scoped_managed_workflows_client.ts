/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type {
  ManagedWorkflowsSystemApi,
  PluginScopedManagedWorkflowsApi,
  WorkflowsClientProvider,
} from '@kbn/workflows/server/types';

/** Binds managed workflow operations to the registering plugin and the executing request. */
export const createPluginScopedManagedWorkflowsClient = (
  pluginId: string,
  systemClient: ManagedWorkflowsSystemApi,
  getClient: WorkflowsClientProvider
): PluginScopedManagedWorkflowsApi => ({
  install: systemClient.install,
  uninstall: systemClient.uninstall,
  ready: systemClient.ready,
  getWorkflowStatus: systemClient.getWorkflowStatus,
  getInstalledWorkflowState: systemClient.getInstalledWorkflowState,
  listInstalledWorkflowStates: systemClient.listInstalledWorkflowStates,
  execute: async (request, id, options) =>
    (await getClient(request)).managedWorkflows.execute(pluginId, id, options),
});
