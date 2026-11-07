/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import Boom from '@hapi/boom';
import { httpServerMock } from '@kbn/core/server/mocks';
import { licenseMock } from '@kbn/licensing-plugin/common/licensing.mock';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { WorkflowsManagementApiActions } from '@kbn/workflows';
import { createWorkflowExecutionReader } from './create_workflow_execution_reader';

const setup = () => {
  const security = securityMock.createStart();
  jest
    .spyOn(security.authz.actions.api, 'get')
    .mockImplementation((privilege) => `api:${privilege}`);
  const check = jest.fn().mockResolvedValue({ hasAllRequested: true });
  security.authz.checkPrivilegesDynamicallyWithRequest.mockReturnValue(check);
  const management = {
    isWorkflowsAvailable: true,
    getWorkflow: jest.fn().mockResolvedValue({ id: 'batch', managed: true }),
    getWorkflowExecutions: jest.fn().mockResolvedValue({ results: [], total: 0 }),
  };
  const getLicense = jest.fn().mockResolvedValue(
    licenseMock.createLicense({
      license: { type: 'enterprise', mode: 'enterprise', status: 'active' },
    })
  );
  const reader = createWorkflowExecutionReader({
    getSpaceId: async () => 'another-space',
    getManagement: () => management,
    getSecurity: async () => security,
    getLicense,
  });
  const request = httpServerMock.createKibanaRequest();
  const read = () => reader.getWorkflowExecutions({ request, workflowId: 'batch', size: 100 });
  return { read, management, check, getLicense, request };
};

describe('native workflow execution reader', () => {
  it('checks current privileges on every read and passes the request and space to native ACLs', async () => {
    const { read, check, management, request } = setup();
    await read();
    expect(management.getWorkflow).toHaveBeenCalledWith('batch', 'another-space', request);
    expect(management.getWorkflowExecutions).toHaveBeenCalledWith(
      { request, workflowId: 'batch', size: 100 },
      'another-space'
    );
    expect(check).toHaveBeenCalledWith({
      kibana: [expect.stringContaining(WorkflowsManagementApiActions.readManagedExecution)],
    });
    management.getWorkflowExecutions.mockClear();
    check.mockResolvedValue({ hasAllRequested: false });
    await expect(read()).rejects.toThrow('Missing workflow execution read privileges');
    expect(management.getWorkflowExecutions).not.toHaveBeenCalled();
  });
  it('requires the extended privilege only for managed workflow executions', async () => {
    const { read, check, management } = setup();
    check
      .mockResolvedValueOnce({ hasAllRequested: true })
      .mockResolvedValueOnce({ hasAllRequested: false });
    await expect(read()).rejects.toThrow();
    expect(management.getWorkflowExecutions).not.toHaveBeenCalled();
    management.getWorkflow.mockResolvedValue({ id: 'batch', managed: false });
    check
      .mockResolvedValueOnce({ hasAllRequested: true })
      .mockResolvedValueOnce({ hasAllRequested: false });
    await expect(read()).resolves.toEqual({ results: [], total: 0 });
  });
  it('does not query executions when the native workflow lookup fails', async () => {
    const { read, management } = setup();
    management.getWorkflow.mockRejectedValue(Boom.forbidden('Private workflow'));
    await expect(read()).rejects.toThrow('Private workflow');
    expect(management.getWorkflowExecutions).not.toHaveBeenCalled();
  });
  it('applies the shared HTTP license policy before authorization or storage reads', async () => {
    const { read, getLicense, management, check } = setup();
    getLicense.mockResolvedValue(licenseMock.createLicense());
    await expect(read()).rejects.toThrow('does not support Workflows');
    expect(check).not.toHaveBeenCalled();
    expect(management.getWorkflow).not.toHaveBeenCalled();
    expect(management.getWorkflowExecutions).not.toHaveBeenCalled();
  });
  it('rejects an unavailable deployment before authorization or storage reads', async () => {
    const { read, management, check } = setup();
    management.isWorkflowsAvailable = false;
    await expect(read()).rejects.toThrow('not available');
    expect(check).not.toHaveBeenCalled();
    expect(management.getWorkflowExecutions).not.toHaveBeenCalled();
  });
});
