/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { expose } from '@kbn/core-remote-common';
import { openIpcSession } from '@kbn/core-remote-server-internal';
import { CoordinatorCapabilities } from '../coordinator_capabilities';
import { WorkerCapabilities } from '../worker_capabilities';
import { prepareWorkerInitialization } from '../worker_initialization';
import { prepareLocalInit } from '../init_inventory';
import { sessionChannelPair } from '../testing/session_channel';
import type { TaskProcessInit } from '../wire';

it('prices lazy initialization separately, budgets steady digests, and releases boot/run handles', async () => {
  const [mainChannel, childChannel] = sessionChannelPair();
  const ids = Array.from({ length: 200 }, (_, i) => `registration-${i}-${'x'.repeat(40)}`);
  const prepared = prepareLocalInit({
    settings: { spacesRuntime: { features: ids } },
    parity: [{ kind: 'steps', ids }],
  });
  const main = openIpcSession<WorkerCapabilities>(
    mainChannel,
    expose(
      new CoordinatorCapabilities(() => undefined, {
        read: async () => prepared,
        getParity: () => [{ kind: 'steps', ids }],
      })
    )
  );
  const child = openIpcSession<CoordinatorCapabilities>(
    childChannel,
    expose(new WorkerCapabilities(() => undefined))
  );
  try {
    const baseline = main.getStats();
    const childBaseline = child.getStats();
    const initialization = await prepareWorkerInitialization(
      child,
      prepared.init as TaskProcessInit
    );
    const before = main.getTraffic();
    expect(await initialization.validateRegistrations({ steps: ids })).toBeNull();
    const initial = main.getTraffic();
    process.stdout.write(
      JSON.stringify({
        lazyInitialization: {
          calls: initial.calls - before.calls,
          bytes: initial.bytes - before.bytes,
        },
      })
    );
    expect(initial.bytes - before.bytes).toBeGreaterThan(5 * 1024);
    for (let run = 0; run < 3; run++) {
      const start = main.getTraffic();
      expect(await initialization.validateRegistrations({ steps: ids })).toBeNull();
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
      const end = main.getTraffic();
      const traffic = { calls: end.calls - start.calls, bytes: end.bytes - start.bytes };
      process.stdout.write(JSON.stringify({ registrationDigest: traffic }));
      expect(traffic.calls).toBeLessThanOrEqual(10);
      expect(traffic.bytes).toBeLessThanOrEqual(5 * 1024);
    }
  } finally {
    child.close();
    main.close();
  }
});
