/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import { getInstallAllTaskStatus } from '../../tasks';
import type { ProductDocInstallClient } from '../doc_install_status';
import type { InstallationStatus } from '../../../common/install_status';
import type { DocGetStatusResponse } from './types';

/** Reads native installation task state and persisted product status for Main and workers. */
export const getProductDocStatus = async ({
  taskManager,
  docInstallClient,
  inferenceId,
}: {
  taskManager: Pick<TaskManagerStartContract, 'fetch'>;
  docInstallClient: ProductDocInstallClient;
  inferenceId: string;
}): Promise<DocGetStatusResponse> => {
  const taskStatus = await getInstallAllTaskStatus({
    taskManager,
    inferenceId,
  });
  if (taskStatus === 'pending') {
    return { status: 'installing' };
  }

  const installStatus = await docInstallClient.getInstallationStatus({ inferenceId });
  // A failed install task may have failed before writing any product status
  const overallStatus =
    taskStatus === 'failed'
      ? 'error'
      : getOverallStatus(Object.values(installStatus).map((v) => v.status));
  return { status: overallStatus, installStatus };
};

export const getOverallStatus = (statuses: InstallationStatus[]): InstallationStatus => {
  const statusOrder: InstallationStatus[] = [
    'error',
    'installing',
    'uninstalling',
    'uninstalled',
    'installed',
  ];
  for (const status of statusOrder) {
    if (statuses.includes(status)) {
      return status;
    }
  }
  return 'installed';
};
