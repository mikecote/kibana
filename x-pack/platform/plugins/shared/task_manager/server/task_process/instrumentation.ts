/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { randomUUID } from 'node:crypto';
import apm from 'elastic-apm-node';
import type { AgentConfigOptions } from 'elastic-apm-node';
import { initApmFromConfiguration } from '@kbn/apm-config-loader';
import type { TelemetryConfiguration } from '@kbn/apm-config-loader';
import { buildOtelResources, initTelemetryFromConfiguration } from '@kbn/telemetry';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { reviveSettings } from './settings';
import type { TaskProcessInit } from './wire';

export interface TaskProcessInstrumentation {
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/** Starts native instrumentation before task modules load using Main's resolved configuration. */
export const initializeTaskProcessInstrumentation = async (
  serialized: NonNullable<TaskProcessInit['instrumentation']>
): Promise<TaskProcessInstrumentation> => {
  const configuration: TelemetryConfiguration = {
    files: serialized.files,
    environment: serialized.environment,
    apm: reviveSettings(serialized.apm) as AgentConfigOptions,
    redactUsers: serialized.redactUsers,
    telemetry: reviveSettings(serialized.telemetry) as TelemetryConfiguration['telemetry'],
    monitoringCollection: reviveSettings(
      serialized.monitoringCollection
    ) as TelemetryConfiguration['monitoringCollection'],
  };
  const serviceName = configuration.apm.serviceName ?? 'kibana';
  initApmFromConfiguration(configuration.apm, configuration.redactUsers, serviceName);
  const telemetry = initTelemetryFromConfiguration(configuration, () =>
    buildOtelResources(serviceName, configuration.apm).merge(
      resourceFromAttributes({ 'service.instance.id': randomUUID() })
    )
  );
  await telemetry.ready;
  const forceFlush = async (): Promise<void> => {
    await Promise.all([telemetry.forceFlush(), apm.isStarted() ? apm.flush() : Promise.resolve()]);
  };
  let shutdownPromise: Promise<void> | undefined;
  return {
    forceFlush,
    shutdown: () =>
      (shutdownPromise ??= (async () => {
        await forceFlush();
        await telemetry.shutdown();
        if (apm.isStarted()) await apm.destroy();
      })()),
  };
};
