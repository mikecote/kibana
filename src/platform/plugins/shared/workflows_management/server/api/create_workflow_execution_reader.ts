/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import Boom from '@hapi/boom';
import type { KibanaRequest } from '@kbn/core/server';
import type { ILicense } from '@kbn/licensing-types';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import {
  WorkflowsManagementApiActions,
  WorkflowsManagementOperationPrivileges,
} from '@kbn/workflows';
import { assertCanReadManagedWorkflowExecution } from './routes/utils/route_security';
import type { WorkflowsManagementApi } from './workflows_management_api';
import { checkWorkflowsLicense } from '../availability/check_workflows_license';

export interface WorkflowExecutionReader {
  getWorkflowExecutions: (
    params: Parameters<WorkflowsManagementApi['getWorkflowExecutions']>[0] & { workflowId: string }
  ) => ReturnType<WorkflowsManagementApi['getWorkflowExecutions']>;
}

interface WorkflowExecutionReaderDependencies {
  getSpaceId: (request: KibanaRequest) => Promise<string>;
  getManagement: () => Pick<
    WorkflowsManagementApi,
    'getWorkflow' | 'getWorkflowExecutions' | 'isWorkflowsAvailable'
  >;
  getLicense: () => Promise<ILicense>;
  getSecurity: () => Promise<Pick<SecurityPluginStart, 'authz'> | undefined>;
}

/** Reads executions with the route's license, API privileges, managed-workflow gate and native ACLs. */
export const createWorkflowExecutionReader = ({
  getSpaceId,
  getManagement,
  getLicense,
  getSecurity,
}: WorkflowExecutionReaderDependencies): WorkflowExecutionReader => ({
  getWorkflowExecutions: async (params) => {
    const spaceId = await getSpaceId(params.request);
    const management = getManagement();
    const license = checkWorkflowsLicense(await getLicense());
    if (!license.valid) throw Boom.forbidden(license.message);
    if (!management.isWorkflowsAvailable)
      throw Boom.forbidden('Workflows is not available in this environment');
    const security = await getSecurity();
    let canReadManaged = false;
    if (security) {
      const check = security.authz.checkPrivilegesDynamicallyWithRequest(params.request);
      const required = await check({
        kibana: WorkflowsManagementOperationPrivileges.readExecution.map((privilege) =>
          security.authz.actions.api.get(privilege)
        ),
      });
      if (!required.hasAllRequested)
        throw Boom.forbidden('Missing workflow execution read privileges');
      const managed = await check({
        kibana: [
          security.authz.actions.api.get(WorkflowsManagementApiActions.readManagedExecution),
        ],
      });
      canReadManaged = managed.hasAllRequested;
    }
    const workflow = await management.getWorkflow(params.workflowId, spaceId, params.request);
    assertCanReadManagedWorkflowExecution(
      {
        authzResult: {
          [WorkflowsManagementApiActions.readExecution]: true,
          [WorkflowsManagementApiActions.readManagedExecution]: canReadManaged,
        },
      },
      workflow
    );
    return management.getWorkflowExecutions(params, spaceId);
  },
});
