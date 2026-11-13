/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { SandboxPluginStart } from './plugin';
import { createSandboxRunServices } from './create_sandbox_run_services';
import {
  SANDBOX_TASK_PROCESS_SETTINGS_ID,
  restoreSandboxTlsCredentials,
} from './task_process_settings';
import type { SandboxTaskProcessSettings } from './task_process_settings';

export interface SandboxTaskProcessRuntime {
  sandbox?: SandboxPluginStart;
}

export const contribution: WorkflowStepsContribution = {
  declares: { settings: [SANDBOX_TASK_PROCESS_SETTINGS_ID] },
  provides: {
    'sandbox.runtime': ({ host: taskHost, settings, services, logger }) => {
      const snapshot = settings[SANDBOX_TASK_PROCESS_SETTINGS_ID] as
        | SandboxTaskProcessSettings
        | undefined;
      if (!snapshot) return {};
      const host = taskHost as TaskHost;
      if (!services || !host.onRunEnd)
        throw new Error('Native Sandbox requires workflow services and lifecycle cleanup');
      const run = createSandboxRunServices({
        config: snapshot.config,
        tlsCredentials: restoreSandboxTlsCredentials(snapshot.tlsCredentials),
        spaces: snapshot.spacesEnabled
          ? services.getService<SpacesPluginStart>('spaces').spacesService
          : undefined,
        logger: logger.get('sandbox'),
      });
      host.onRunEnd(async () => {
        run.stop();
      });
      return { sandbox: run.sandbox };
    },
  },
  register: () => {},
};
