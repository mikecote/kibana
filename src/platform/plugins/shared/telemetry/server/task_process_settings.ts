/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { CloudDeploymentMetadata } from '@kbn/cloud-plugin/common/register_cloud_deployment_id_analytics_context';
import { getTelemetryChannelEndpoint } from '../common/telemetry_config';
import type { TelemetryConfigLabels, TelemetryConfigType } from './config';

/**
 * What a task process is sent so that the analytics events of a run are shipped as Kibana ships
 * them. Plain data, in the format `serializeSettings` of Task Manager handles.
 */
export interface TelemetryTaskProcessSettings {
  /** The opt-in status as Kibana has it; undefined until Kibana knows it, which ships nothing. */
  optIn?: boolean;
  /** Where usage is sent: the `telemetry.sendUsageTo` config. */
  sendUsageTo: TelemetryConfigType['sendUsageTo'];
  /**
   * The URL `getTelemetryUrl` resolves to in Kibana, which plugins with a channel of their own (such
   * as security telemetry) derive their endpoints from.
   */
  snapshotUrl: string;
  /** The `telemetry.labels` config, which Kibana adds to the context of every event. */
  labels: TelemetryConfigLabels;
  /**
   * The license as Kibana has it, which is part of the context of its events. Telemetry cannot read
   * it, so the plugin that registers the settings with a task type adds it.
   */
  license?: { uid?: string; status?: string; type?: string };
  /** The cloud deployment or project, part of the context of events; added like `license`. */
  cloud?: CloudDeploymentMetadata;
  /** Overrides the endpoint events are sent to; Kibana never sends it, a test does. */
  shipperUrl?: string;
}

export const getTaskProcessSettings = ({
  config,
  isOptedIn,
}: {
  config: Pick<TelemetryConfigType, 'sendUsageTo' | 'labels' | 'appendServerlessChannelsSuffix'>;
  isOptedIn?: boolean;
}): TelemetryTaskProcessSettings => ({
  ...(isOptedIn !== undefined ? { optIn: isOptedIn } : {}),
  sendUsageTo: config.sendUsageTo,
  snapshotUrl: getTelemetryChannelEndpoint({
    appendServerlessChannelsSuffix: config.appendServerlessChannelsSuffix,
    env: config.sendUsageTo,
    channelName: 'snapshot',
  }),
  labels: config.labels,
});
