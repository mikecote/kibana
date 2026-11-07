/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createPrivateTemporaryDirectory } from '@kbn/fs';
import type { PrivateTemporaryDirectory } from '@kbn/fs';
import type { AgentConfigOptions } from 'elastic-apm-node';
import { isTelemetryEnvironmentFileKey } from '@kbn/apm-config-loader';
import { reviveSettings, serializeSettings } from './settings';
import type { TaskProcessInit } from './wire';

type Instrumentation = Pick<
  NonNullable<TaskProcessInit['instrumentation']>,
  'apm' | 'environment' | 'files'
>;

/** Materializes only the certificate bytes captured by Main before native SDK initialization. */
export const materializeTaskProcessInstrumentationFiles = (
  serialized: Instrumentation
): { instrumentation: Instrumentation; cleanup: () => void } => {
  if (!Array.isArray(serialized.files)) {
    throw new Error('Native instrumentation requires portable certificate metadata');
  }
  const apm = reviveSettings(serialized.apm) as AgentConfigOptions;
  const environment = { ...serialized.environment };
  let directory: PrivateTemporaryDirectory | undefined;
  const cleanup = (): void => {
    directory?.cleanup();
  };
  try {
    serialized.files.forEach(({ target, data }, index) => {
      directory ??= createPrivateTemporaryDirectory('kbn-task-instrumentation-');
      const name = `certificate_${index}.pem`;
      const path = directory.getPath(name);
      if (data !== null) directory.writeFile(name, Buffer.from(data, 'base64'));
      switch (target.kind) {
        case 'apm':
          if (target.key !== 'serverCaCertFile')
            throw new Error('Unsupported native APM file setting');
          apm.serverCaCertFile = path;
          break;
        case 'environment':
          if (!isTelemetryEnvironmentFileKey(target.key))
            throw new Error('Unsupported native instrumentation environment file');
          environment[target.key] = path;
          break;
        default:
          throw new Error('Unsupported native instrumentation file target');
      }
    });
    return {
      instrumentation: { ...serialized, apm: serializeSettings(apm), environment },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};
