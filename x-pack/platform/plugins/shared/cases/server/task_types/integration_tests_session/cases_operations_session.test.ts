/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { httpServerMock } from '@kbn/core/server/mocks';
import { brandSpaceId } from '@kbn/core-spaces-common';
import { CoordinatorCapabilities } from '@kbn/task-manager-plugin/server/task_process/coordinator_capabilities';
import { WorkerCapabilities } from '@kbn/task-manager-plugin/server/task_process/worker_capabilities';
import { openWorkerRunControl } from '@kbn/task-manager-plugin/server/task_process/worker_run_control';
import { sessionChannelPair } from '@kbn/task-manager-plugin/server/task_process/testing/session_channel';
import { AdHocTaskCounter } from '@kbn/task-manager-plugin/server/lib/adhoc_task_counter';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { ConnectorTypes } from '../../../common/types/domain';
import type { CasesClient } from '../../client';
import { defineCasesOperations } from '../cases_operations';
import { createCoordinatorCasesClient } from '../coordinator_cases_client';

const SEAM_BUDGET = { calls: 10, bytes: 5 * 1024 } as const;

it('keeps native step client calls typed, scoped, budgeted and leak-free over the session', async () => {
  const [mainChannel, childChannel] = sessionChannelPair();
  let active = true;
  const nativeRequest = httpServerMock.createKibanaRequest();
  const createRequest = jest.fn(() => nativeRequest);
  const nativeCreate = jest.fn(async () => ({
    id: 'case-id',
    title: 'case title',
    version: 'one',
  }));
  const getClient = jest.fn(
    async () => ({ cases: { create: nativeCreate } } as unknown as CasesClient)
  );
  const root = new CoordinatorCapabilities(
    () => (active ? { reportProgress: () => {}, getCurrentTasksInPool: () => ['run'] } : undefined),
    undefined,
    { manifest: [defineCasesOperations(getClient)], requests: { create: createRequest } }
  );
  const main = openIpcSession<WorkerCapabilities>(mainChannel, expose(root));
  const child = openIpcSession<CoordinatorCapabilities>(
    childChannel,
    expose(new WorkerCapabilities(() => undefined))
  );
  try {
    const baseline = main.getStats();
    const childBaseline = child.getStats();
    for (let run = 0; run < 3; run++) {
      active = true;
      const start = main.getTraffic();
      const control = await openWorkerRunControl(
        child,
        `run-${run}`,
        new AdHocTaskCounter(),
        new AbortController().signal
      );
      const request = httpServerMock.createKibanaRequest({
        headers: { authorization: 'ApiKey worker-resolved-key' },
        spaceId: brandSpaceId('custom'),
      });
      const user = { username: 'workflow-user', profile_uid: 'profile' };
      const host = {
        withCoordinatorCapability: control.withCoordinatorCapability,
        security: { authc: { getCurrentUser: () => user } },
      } as unknown as TaskHost;
      const client = createCoordinatorCasesClient(host, request, {
        actionSource: {
          type: 'workflow',
          id: 'workflow-id',
          name: 'workflow',
          run_id: 'execution',
        },
      });
      const input = {
        title: 'case title',
        description: 'description',
        tags: [],
        owner: 'cases',
        connector: { id: 'none', name: 'none', type: ConnectorTypes.none, fields: null },
        settings: { syncAlerts: true },
      };
      expect(await client.cases.create(input)).toEqual({
        id: 'case-id',
        title: 'case title',
        version: 'one',
      });
      // The capability is acquired once per run; subsequent business uses are one method RPC each.
      const beforeSecond = main.getTraffic();
      await client.cases.create(input);
      expect(main.getTraffic().calls - beforeSecond.calls).toBe(1);
      expect(createRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          apiKey: 'worker-resolved-key',
          spaceId: 'custom',
          userName: 'workflow-user',
          userProfileId: 'profile',
        })
      );
      expect(getClient).toHaveBeenLastCalledWith(
        nativeRequest,
        expect.objectContaining({
          actionSource: {
            type: 'workflow',
            id: 'workflow-id',
            name: 'workflow',
            run_id: 'execution',
          },
        })
      );
      const traffic = main.getTraffic();
      const measured = { calls: traffic.calls - start.calls, bytes: traffic.bytes - start.bytes };
      process.stdout.write(`${JSON.stringify({ casesRun: measured })}\n`);
      expect(measured.calls).toBeLessThanOrEqual(SEAM_BUDGET.calls);
      expect(measured.bytes).toBeLessThanOrEqual(SEAM_BUDGET.bytes);
      active = false;
      await expect(client.cases.create(input)).rejects.toThrow('No leased task execution');
      await control.dispose();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          JSON.stringify(main.getStats()) === JSON.stringify(baseline) &&
          JSON.stringify(child.getStats()) === JSON.stringify(childBaseline)
        )
          break;
        await delay(10);
      }
      expect(main.getStats()).toEqual(baseline);
      expect(child.getStats()).toEqual(childBaseline);
    }
  } finally {
    child.close();
    main.close();
  }
});
