/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { URL } from 'url';
import type { Logger } from '@kbn/core/server';
import type { AnalyticsServiceSetup } from '@kbn/core-analytics-server';
import type { TelemetryPluginSetup, TelemetryPluginStart } from '@kbn/telemetry-plugin/server';
import type { IUsageCounter } from '@kbn/usage-collection-plugin/server/usage_counters/usage_counter';
import {
  AsyncTelemetryEventsSender,
  DEFAULT_QUEUE_CONFIG,
  DEFAULT_RETRY_CONFIG,
} from './async_sender';
import type { ITelemetryEventsSender } from './sender';
import type { ITelemetryReceiver } from './receiver';
import type { ESClusterInfo, ESLicense } from './types';

/** What a rule run calls on the telemetry sender: it only queues events to send. */
export type RuleRunTelemetrySender = Pick<ITelemetryEventsSender, 'sendAsync'>;

/**
 * What Kibana tells a task process about telemetry, a snapshot of what its own sender reads from the
 * telemetry plugin and the receiver, as plain data.
 */
export interface RuleRunTelemetrySettings {
  /** Whether telemetry is opted in, as Kibana has it. Nothing is sent unless it is `true`. */
  optIn?: boolean;
  /** The URL of the telemetry plugin, which the endpoint of each channel derives from. */
  snapshotUrl: string;
  /** The cluster the events are about, which each event and request carry. */
  clusterInfo?: ESClusterInfo;
  /** The license of the cluster, which each event and request carry. */
  licenseInfo?: ESLicense | null;
}

/** Kibana's end: the snapshot of its own state that a process builds its sender from. */
export const getRuleRunTelemetrySettings = ({
  telemetry,
  receiver,
}: {
  telemetry?: Pick<TelemetryPluginSetup, 'getTaskProcessSettings'>;
  receiver: Pick<ITelemetryReceiver, 'getClusterInfo' | 'getLicenseInfo'>;
}): RuleRunTelemetrySettings | undefined => {
  const settings = telemetry?.getTaskProcessSettings();
  if (!settings) return undefined;
  return {
    optIn: settings.optIn,
    snapshotUrl: settings.snapshotUrl,
    clusterInfo: receiver.getClusterInfo() ?? undefined,
    licenseInfo: receiver.getLicenseInfo(),
  };
};

/**
 * The sender of a rule run, built from explicit dependencies: Kibana's own `AsyncTelemetryEventsSender`
 * (the queues, the chunking, the retries and the counters) over what a snapshot of Kibana says in place
 * of the telemetry plugin and the receiver. A task process builds it and calls `flush` before it
 * answers a run, because the queues would otherwise wait for a buffer time the process does not live for.
 */
export const createRuleRunTelemetrySender = ({
  logger,
  settings,
  usageCounter,
  analytics,
}: {
  logger: Logger;
  settings: RuleRunTelemetrySettings;
  usageCounter?: IUsageCounter;
  analytics?: AnalyticsServiceSetup;
}): { sender: RuleRunTelemetrySender; flush: () => Promise<void>; stop: () => Promise<void> } => {
  const async = new AsyncTelemetryEventsSender(logger);
  // What the async sender reads of the receiver; the snapshot has it from Kibana's.
  const receiver = {
    getClusterInfo: () => settings.clusterInfo,
    getLicenseInfo: () => settings.licenseInfo,
    fetchLicenseInfo: async () => settings.licenseInfo,
  } as unknown as ITelemetryReceiver;
  async.setup(
    DEFAULT_RETRY_CONFIG,
    DEFAULT_QUEUE_CONFIG,
    receiver,
    { getTelemetryUrl: async () => new URL(settings.snapshotUrl) } as TelemetryPluginSetup,
    usageCounter,
    analytics
  );
  async.start({ getIsOptedIn: async () => settings.optIn === true } as TelemetryPluginStart);
  return {
    sender: { sendAsync: (channel, events) => async.send(channel, events) },
    flush: () => async.flush(),
    stop: () => async.stop(),
  };
};
