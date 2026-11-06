/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { coreMock } from '@kbn/core/server/mocks';
import { serializeSettings } from '@kbn/task-manager-plugin/server/task_process/settings';
import { setTaskProcessContext } from '@kbn/task-manager-plugin/server/task_process/context';
import type { TaskProcessContext } from '@kbn/task-manager-plugin/server/task_process/context';
import { createTelemetryTaskPlugin } from './task_plugin';
import type { TelemetryTaskProcessSettings } from './task_process_settings';

const start = async (settings?: TelemetryTaskProcessSettings) => {
  const context: TaskProcessContext = {
    init: { settings: settings ? { telemetry: serializeSettings(settings) } : {} } as never,
    module: {} as never,
    contributions: {},
    definitions: new Map(),
    flushers: [],
  };
  setTaskProcessContext(context);
  const core = coreMock.createSetup();
  const instance = await createTelemetryTaskPlugin('9.9.9').definition.taskPlugin!(
    coreMock.createPluginInitializerContext()
  );
  await instance.setup(core, {});
  return { core, context };
};

describe('the telemetry task plugin', () => {
  it('is a plugin of a process that depends on nothing', () => {
    expect(createTelemetryTaskPlugin('9.9.9').manifest).toEqual(
      expect.objectContaining({ id: 'telemetry', requiredPlugins: [], optionalPlugins: [] })
    );
  });

  it('registers the shipper of Kibana, opted in, and flushes it before a run answers', async () => {
    const { core, context } = await start({
      optIn: true,
      sendUsageTo: 'staging',
      snapshotUrl: 'https://telemetry-staging.elastic.co/xpack/v2/send',
      labels: { branch: 'main' },
      license: { uid: 'id', status: 'active', type: 'basic' },
      cloud: { id: 'cloud-id' },
    });

    expect(core.analytics.optIn).toHaveBeenCalledWith({ global: { enabled: true } });
    expect(core.analytics.registerShipper).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        channelName: 'kibana-server',
        version: 'version',
        buildShipperUrl: expect.any(Function),
        buildShipperHeaders: expect.any(Function),
      })
    );
    expect(core.analytics.registerContextProvider.mock.calls.map(([{ name }]) => name)).toEqual([
      'telemetry labels',
      'license info',
      'Cloud Deployment Metadata',
    ]);
    // The shipper has not been built by a mock client, so there is nothing to flush yet.
    expect(context.flushers).toHaveLength(1);
    await expect(context.flushers[0]()).resolves.toBeUndefined();
  });

  it('builds the shipper url from where Kibana sends usage, unless a url is given', async () => {
    const urlOf = async (settings: Partial<TelemetryTaskProcessSettings>) => {
      const { core } = await start({
        optIn: true,
        sendUsageTo: 'staging',
        snapshotUrl: '',
        labels: {},
        ...settings,
      });
      const [, config] = core.analytics.registerShipper.mock.calls[0] as [
        unknown,
        { buildShipperUrl: (options: { channelName: string }) => string }
      ];
      return config.buildShipperUrl({ channelName: 'kibana-server' });
    };

    expect(await urlOf({ sendUsageTo: 'staging' })).toContain('telemetry-staging');
    expect(await urlOf({ sendUsageTo: 'prod' })).not.toContain('staging');
    expect(await urlOf({ shipperUrl: 'http://localhost:1234/ship' })).toBe(
      'http://localhost:1234/ship'
    );
  });

  it.each([
    ['not opted in', { optIn: false, sendUsageTo: 'prod' as const, snapshotUrl: '', labels: {} }],
    ['not yet known', { sendUsageTo: 'prod' as const, snapshotUrl: '', labels: {} }],
    ['not sent', undefined],
  ])('ships nothing when the opt-in of Kibana is %s', async (_, settings) => {
    const { core, context } = await start(settings);

    expect(core.analytics.optIn).not.toHaveBeenCalled();
    expect(core.analytics.registerShipper).not.toHaveBeenCalled();
    expect(context.flushers).toEqual([]);
  });
});
