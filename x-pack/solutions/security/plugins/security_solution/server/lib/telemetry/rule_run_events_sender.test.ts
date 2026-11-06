/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import axios from 'axios';
import { loggingSystemMock } from '@kbn/core/server/mocks';
import { createMockUsageCounter, stubClusterInfo, stubLicenseInfo } from './__mocks__';
import {
  createRuleRunTelemetrySender,
  getRuleRunTelemetrySettings,
} from './rule_run_events_sender';
import type { RuleRunTelemetrySettings } from './rule_run_events_sender';
import { TelemetryChannel } from './types';

jest.mock('axios');

describe('rule run telemetry sender', () => {
  const post = jest.spyOn(axios, 'post');
  const get = jest.spyOn(axios, 'get');
  const logger = loggingSystemMock.createLogger();
  const created: Array<{ stop: () => Promise<void> }> = [];
  const settings: RuleRunTelemetrySettings = {
    optIn: true,
    snapshotUrl: 'https://telemetry-staging.elastic.co/xpack/v2/send',
    clusterInfo: stubClusterInfo,
    licenseInfo: stubLicenseInfo,
  };

  beforeEach(() => {
    post.mockReset().mockResolvedValue({ status: 201 });
    get.mockReset().mockResolvedValue({ status: 200 });
  });

  // The queues keep timers that would keep the test alive.
  afterEach(async () => {
    await Promise.all(created.splice(0).map(({ stop }) => stop()));
  });

  const createSender = (...args: Parameters<typeof createRuleRunTelemetrySender>) => {
    const result = createRuleRunTelemetrySender(...args);
    created.push(result);
    return result;
  };

  describe('createRuleRunTelemetrySender', () => {
    it('sends the queued events when flushed, to the channel endpoint, with the cluster and license of Kibana', async () => {
      const usageCounter = createMockUsageCounter();
      const { sender, flush } = createSender({ logger, settings, usageCounter });

      sender.sendAsync(TelemetryChannel.DETECTION_ALERTS, [{ alert: 'a' }, { alert: 'b' }]);
      // Well before the buffer time of the queue.
      await flush();

      expect(post).toHaveBeenCalledTimes(1);
      const [url, body, config] = post.mock.calls[0];
      expect(url).toBe(
        `https://telemetry-staging.elastic.co/v3-dev/send/${TelemetryChannel.DETECTION_ALERTS}`
      );
      const events = String(body)
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events).toEqual([
        expect.objectContaining({
          alert: 'a',
          cluster_uuid: stubClusterInfo.cluster_uuid,
          cluster_name: stubClusterInfo.cluster_name,
          license: expect.any(Object),
        }),
        expect.objectContaining({ alert: 'b' }),
      ]);
      expect(config?.headers).toEqual(
        expect.objectContaining({
          'X-Elastic-Cluster-ID': stubClusterInfo.cluster_uuid,
          'X-Telemetry-Sender': 'async',
        })
      );
      expect(usageCounter.incrementCounter).toHaveBeenCalled();
    });

    it('sends nothing when Kibana is not opted in', async () => {
      const { sender, flush } = createSender({
        logger,
        settings: { ...settings, optIn: false },
      });

      sender.sendAsync(TelemetryChannel.DETECTION_ALERTS, [{ alert: 'a' }]);
      await flush();

      expect(post).not.toHaveBeenCalled();
    });

    it('answers when the events cannot be sent', async () => {
      post.mockRejectedValue(new Error('endpoint down'));
      const { sender, flush } = createSender({ logger, settings });

      sender.sendAsync(TelemetryChannel.DETECTION_ALERTS, [{ alert: 'a' }]);

      await expect(flush()).resolves.toBeUndefined();
    }, 20_000);
  });

  describe('getRuleRunTelemetrySettings', () => {
    const receiver = {
      getClusterInfo: () => stubClusterInfo,
      getLicenseInfo: () => stubLicenseInfo,
    };

    it('is a snapshot of what the telemetry plugin and the receiver of Kibana say', () => {
      expect(
        getRuleRunTelemetrySettings({
          telemetry: {
            getTaskProcessSettings: () => ({
              optIn: true,
              sendUsageTo: 'staging',
              snapshotUrl: 'https://snapshot',
              labels: {},
            }),
          },
          receiver,
        })
      ).toEqual({
        optIn: true,
        snapshotUrl: 'https://snapshot',
        clusterInfo: stubClusterInfo,
        licenseInfo: stubLicenseInfo,
      });
    });

    it('is nothing without the telemetry plugin, which sends nothing as in Kibana', () => {
      expect(getRuleRunTelemetrySettings({ receiver })).toBeUndefined();
    });
  });
});
