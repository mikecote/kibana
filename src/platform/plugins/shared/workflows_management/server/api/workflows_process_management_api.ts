/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { Logger } from '@kbn/core/server';
import type {
  PluginScopedManagedWorkflowsApi,
  WorkflowsClientProvider,
} from '@kbn/workflows/server/types';
import { createPluginScopedManagedWorkflowsClient } from '@kbn/workflows-extensions/server';
import { WorkflowManagementAuditLog } from './routes/utils/workflow_audit_logging';
import { WorkflowsManagementApi } from './workflows_management_api';
import {
  createManagedWorkflowsSystemApiProvider,
  createWorkflowsClientProvider,
} from '../client/workflows_client';
import type { WorkflowManagementRuntimeDependencies } from '../runtime/dependencies';
import { WorkflowsRuntime } from '../runtime/workflows_runtime';

export interface WorkflowsProcessManagementApiDeps extends WorkflowManagementRuntimeDependencies {
  logger: Logger;
  kibanaVersion: string;
  isWorkflowsAvailable: boolean;
  onRunEnd: (flusher: () => Promise<void>) => void;
}

export interface WorkflowsProcessServices {
  management: WorkflowsManagementApi;
  getClient: WorkflowsClientProvider;
  initManagedWorkflowsClient: (pluginId: string) => Promise<PluginScopedManagedWorkflowsApi>;
}

/** Builds management, trigger and managed workflow clients over the same execution runtime. */
export const createWorkflowsProcessServices = ({
  logger,
  kibanaVersion,
  isWorkflowsAvailable,
  onRunEnd,
  ...dependencies
}: WorkflowsProcessManagementApiDeps): WorkflowsProcessServices => {
  const runtime = new WorkflowsRuntime(
    { ...dependencies, installStorage: false },
    logger,
    kibanaVersion
  );
  const api = new WorkflowsManagementApi(runtime, isWorkflowsAvailable, logger);
  api.setAuditLog(new WorkflowManagementAuditLog({ service: runtime }));
  onRunEnd(async () => {
    try {
      await api.flush();
    } finally {
      runtime.setStopping(true);
    }
  });
  const config = { available: isWorkflowsAvailable };
  const getClient = createWorkflowsClientProvider(runtime, config, logger);
  const getSystemClient = createManagedWorkflowsSystemApiProvider(runtime, config, logger);
  return {
    management: api,
    getClient,
    initManagedWorkflowsClient: async (pluginId) => {
      if (!pluginId) throw new Error('pluginId is required to initialize managed workflows client');
      return createPluginScopedManagedWorkflowsClient(
        pluginId,
        await getSystemClient(pluginId),
        getClient
      );
    },
  };
};

/** Builds the same management API as Kibana from this execution's services. */
export const createWorkflowsProcessManagementApi = (
  dependencies: WorkflowsProcessManagementApiDeps
): WorkflowsManagementApi => createWorkflowsProcessServices(dependencies).management;
