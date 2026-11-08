/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Server } from 'node:http';
import type { Logger } from '@kbn/logging';
import {
  incrementCreatedTaskCount,
  requestDispatchTaskPool,
  accumulateTaskProcessMetrics,
} from './run_context';
import { throwUnrecoverableError } from '../task_running/errors';
import { TASK_PROCESS_PROTOCOL_VERSION } from './protocol';
import { RemoteTaskRunner } from './remote_task_runner';
import { startTaskProcessServer } from './server';
import { TaskProcessSupervisor } from './supervisor';
import type { TaskProcessSettings } from './supervisor';
import type { TaskProcessSupervisorStats } from './supervisor';

export interface TaskProcessWorkerOptions {
  settings: Omit<TaskProcessSettings, 'getElasticsearchConfig' | 'getInitFor'>;
  logger: Logger;
  authToken: string;
  port: number;
  host?: string;
}

/** Starts an authenticated remote supervisor over the same bundles used by child-process mode. */
export const startTaskProcessWorker = ({
  settings,
  logger,
  authToken,
  port,
  host,
}: TaskProcessWorkerOptions): {
  server: Server;
  supervisor: TaskProcessSupervisor;
  getStats: () => TaskProcessSupervisorStats;
  stop: () => Promise<void>;
} => {
  if (!authToken) throw new Error('A task worker requires an authentication token');
  const supervisor = new TaskProcessSupervisor({
    settings: {
      ...settings,
      getElasticsearchConfig: () => {
        throw new Error('A task worker requires a dispatch snapshot');
      },
    },
    logger,
  });
  supervisor.start();
  const server = startTaskProcessServer({
    taskDefinitions: new Map(),
    port,
    host,
    authToken,
    logger,
    kibanaVersion: settings.kibanaVersion,
    getTaskTypes: () => supervisor.getTaskTypes(),
    getFeatureFlagDefinitions: (taskType) => supervisor.getFeatureFlagDefinitions(taskType),
    collectGauges: (owner) => {
      if (!owner) throw new Error('A remote gauge collection requires its dispatch owner');
      return supervisor.collectGaugeMetrics(owner);
    },
    forwardRun: (request, { signal, setCustomTaskRunEventFields }) => {
      const { snapshot, deadline, ...run } = request;
      if (
        snapshot?.protocolVersion !== TASK_PROCESS_PROTOCOL_VERSION ||
        snapshot.init.kibanaVersion !== settings.kibanaVersion ||
        !deadline ||
        !Number.isFinite(Date.parse(deadline))
      ) {
        throwUnrecoverableError(new Error('Invalid task worker dispatch snapshot or deadline'));
      }
      return new RemoteTaskRunner({
        route: supervisor.getRoute(request.taskType),
        request: { ...run, snapshot, featureFlags: snapshot?.featureFlags },
        timeoutMs: Math.max(0, Date.parse(deadline ?? '') - Date.now()),
        signal,
        setCustomTaskRunEventFields,
        onTasksCreated: incrementCreatedTaskCount,
        onMetrics: accumulateTaskProcessMetrics,
        getCurrentTasksInPool: requestDispatchTaskPool,
      });
    },
    onShutdown: () => supervisor.stop(),
  });
  return {
    server,
    supervisor,
    getStats: () => supervisor.getStats(),
    stop: async () => {
      server.close();
      await supervisor.stop();
      server.closeAllConnections();
    },
  };
};
