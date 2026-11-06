/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock } from '@kbn/core/server/mocks';

import { WORKFLOW_SERVICE_ACCOUNT_TYPE } from './service_account_execution';
import { createWorkflowsEngineTaskPlugin, WORKFLOW_WORKLOAD_TYPE_NAME } from './task_plugin';

describe('the workflows execution engine task plugin', () => {
  const plugin = createWorkflowsEngineTaskPlugin('9.5.0');

  it('has the id of the real plugin, which Core scopes registrations by', () => {
    expect(plugin.manifest.id).toBe('workflowsExecutionEngine');
  });

  it('registers the workflow workload type of service accounts, as the plugin does in Kibana', async () => {
    const instance = await plugin.definition.plugin!(
      coreMock.createPluginInitializerContext() as never
    );
    const setup = coreMock.createSetup();
    (instance as { setup: (core: unknown) => void }).setup(setup);

    expect(setup.security.serviceAccounts.registerWorkloadType).toHaveBeenCalledTimes(1);
    expect(setup.security.serviceAccounts.registerWorkloadType).toHaveBeenCalledWith({
      type: WORKFLOW_SERVICE_ACCOUNT_TYPE,
      name: WORKFLOW_WORKLOAD_TYPE_NAME,
    });
  });

  it('provides the service accounts of the plugin to the runtime of a run', async () => {
    const instance = await plugin.definition.plugin!(
      coreMock.createPluginInitializerContext() as never
    );
    const start = coreMock.createStart();
    const contract = (instance as unknown as { start: (core: unknown) => unknown }).start(start);

    expect(contract).toEqual({ serviceAccounts: start.security.serviceAccounts });
  });
});
