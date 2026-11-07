/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { createEntityStoreRunServices } from '../entity_store_run_services';
import { registerEntityStoreWorkflowSteps } from '../workflow/steps';
import { registerTriggers } from '../workflow/triggers';

/**
 * The workflow steps and triggers of the plugin, in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The step's services come
 * from the host (the license, the security task plugin) and the runtime of the engine, which emits the
 * trigger events of the entities the step updates.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry, { host, logger, services }) => {
    const { licensing, plugins } = host as TaskHost;
    const { createCRUDClient } = createEntityStoreRunServices({
      logger: logger.get('entityStore'),
    });

    // The events the steps emit and that are still in flight: the process ends with the run.
    const pendingEvents = new Set<Promise<void>>();
    registerTriggers(registry);
    registerEntityStoreWorkflowSteps(registry, {
      getCreateCRUDClient: async () => createCRUDClient,
      getWorkflowsExtensions: async () =>
        services && {
          getClient: async (request) => ({
            emitEvent: (triggerId, payload) => {
              const emitted = services.emitEvent({ triggerId, payload, request });
              pendingEvents.add(emitted);
              const forget = () => pendingEvents.delete(emitted);
              emitted.then(forget, forget);
              return emitted;
            },
          }),
          flushEvents: async () => {
            // The entity client emits without waiting: let it start the emissions first.
            await new Promise((resolve) => setImmediate(resolve));
            await Promise.allSettled([...pendingEvents]);
          },
        },
      getLicensing: async () => {
        if (!licensing) throw new Error('The workflows task module did not get the license');
        return { getLicense: () => firstValueFrom(licensing.license$) };
      },
      getSecurity: async () => {
        const security = plugins?.security as Pick<SecurityPluginStart, 'authz'> | undefined;
        if (!security) throw new Error('The task process did not get the security plugin');
        return security;
      },
    });
  },
};
