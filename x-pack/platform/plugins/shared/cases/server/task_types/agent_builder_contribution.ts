/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { PluginStartContract as ActionsStart } from '@kbn/actions-plugin/server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowTriggerEmitterSource } from '@kbn/workflows-extensions/server';
import type { CasesAlertsClient } from '../services/alerts';
import { APP_ID } from '../../common/constants';
import { registerCasesAgentBuilderToolsWithServices } from '../agent_builder';
import { CasesEventBus } from '../events/event_bus';
import { createCasesClientExtensions } from './create_client_extensions';
import { registerCasesWorkflowEventBridge } from '../workflows/triggers/event_bridge';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';
import { getCasesTaskProcessSavedObjectTypes } from './cases_saved_object_types';
import { createCasesRunServices } from './create_cases_run_services';
import type { CasesRunServices } from './create_cases_run_services';
import type { CasesTaskProcessAttachmentTypes } from './create_attachment_type_registry';

/** The id of the settings the plugin sends a task process to register its agent builder tools. */
export const CASES_AGENT_BUILDER_SETTINGS_ID = 'casesAgentBuilder';

/** What cases sends a task process for its agent builder registrations (decided in Kibana). */
export interface CasesAgentBuilderSettings {
  /** What the cases client reads, as for the steps; absent until Kibana has started. */
  workflows?: CasesWorkflowsProcessSettings;
}

/**
 * What the cases plugin registers with agent builder, in the task process of the workflow task types:
 * the cases tools, the skills and the attachment types, which `setup()` registers with the same
 * function. The tools use the cases client of `createCasesRunServices` (the factory Kibana uses, over
 * the services of the process); whether the plugin registers at all (the serverless project type),
 * and the switches of templates, attachments and analytics, are decided in Kibana and read from the
 * settings it sends. The events a tool emits (a case created) reach the engine through the bridge
 * of the plugin, and the run waits for them.
 *
 * Attachment, alert and file operations share native services with the workflow runtime.
 * Native notifications and solution callbacks share the workflow client services.
 */
export const contribution: AgentBuilderContribution = {
  declares: {
    savedObjectTypes: getCasesTaskProcessSavedObjectTypes(),
    settings: [CASES_AGENT_BUILDER_SETTINGS_ID],
  },
  register: (agentBuilder, context) => {
    const { host, logger, settings, services } = context;
    const { workflows } =
      (settings[CASES_AGENT_BUILDER_SETTINGS_ID] as CasesAgentBuilderSettings | undefined) ?? {};
    // Without the settings cases is disabled (or not allowed) in this Kibana: nothing is registered.
    if (!workflows) return;
    // What the registrations read of the host is read when a tool runs, not while registering.
    const taskHost = host as TaskHost;
    const casesLogger = logger.get('cases');
    const casesEventBus = new CasesEventBus(casesLogger);
    const clientExtensions = createCasesClientExtensions(context, workflows);
    clientExtensions.registerAlertStatusListeners(casesEventBus);
    const attachmentTypes =
      services.getService<CasesTaskProcessAttachmentTypes>('cases.attachmentTypes');
    const unifiedAttachmentTypeRegistry = attachmentTypes.registry;
    let run: CasesRunServices | undefined;
    const getRun = () => {
      if (!run) {
        const { elasticsearch, savedObjects, licensing, userProfile, security, usageCounters } =
          taskHost;
        const securityPlugin = taskHost.plugins?.security as SecurityTaskPluginStart | undefined;
        if (!securityPlugin) throw new Error('The task process did not get the security plugin');
        if (!usageCounters) throw new Error('The workflows task module did not get usage counters');
        if (!licensing) throw new Error('The workflows task module did not get the license');
        if (!userProfile) {
          throw new Error('The task process host did not lend Core user profile service');
        }
        run = createCasesRunServices({
          logger: casesLogger,
          settings: workflows,
          elasticsearch,
          savedObjects,
          security: securityPlugin,
          securityService: security,
          isFipsMode: security.fips.isEnabled(),
          getAttachmentParityError: () =>
            attachmentTypes.getParityError() ?? clientExtensions.getParityError(),
          closeReasonValidator: clientExtensions.closeReasonValidator,
          getRacClientWithRequest: (request) =>
            services
              .getService<{
                getRacClientWithRequest: (
                  scopedRequest: KibanaRequest
                ) => Promise<CasesAlertsClient>;
              }>('ruleRegistry')
              .getRacClientWithRequest(request),
          userProfile,
          spaces: workflows.spacesEnabled
            ? services.getService<SpacesPluginStart>('spaces').spacesService
            : undefined,
          licensing,
          getActionsClientWithRequest: services.getActionsClientWithRequest,
          getUnsecuredActionsClient: () =>
            services
              .getService<Pick<ActionsStart, 'getUnsecuredActionsClient'>>('actions')
              .getUnsecuredActionsClient(),
          usageCounter: usageCounters.getUsageCounter(APP_ID),
          filesUsageCounter: usageCounters.getUsageCounter('files'),
          analytics: taskHost.analytics,
          publicBaseUrl: taskHost.server.publicBaseUrl,
          casesEventBus,
          clientSource: 'agent_builder',
          unifiedAttachmentTypeRegistry,
        });
      }
      return run;
    };

    // The events the tools emit and that are still in flight: the process ends with the run.
    const pendingEvents = new Set<Promise<void>>();
    const workflowsExtensions: WorkflowTriggerEmitterSource = {
      getClient: async (request: KibanaRequest) => ({
        emitEvent: (triggerId, payload) => {
          const emitted = services.emitEvent({ triggerId, payload, request });
          pendingEvents.add(emitted);
          const forget = () => pendingEvents.delete(emitted);
          emitted.then(forget, forget);
          return emitted;
        },
      }),
    };
    registerCasesWorkflowEventBridge(casesEventBus, workflowsExtensions, casesLogger);
    taskHost.onRunEnd?.(async () => {
      // The bridge emits without waiting: let it start the emissions first.
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.allSettled([...pendingEvents]);
    });

    registerCasesAgentBuilderToolsWithServices(
      agentBuilder,
      (request: KibanaRequest) => getRun().getCasesClient(request),
      {
        getBasePath: async () => ({
          publicBaseUrl: taskHost.server.publicBaseUrl,
          serverBasePath: taskHost.http.basePath.serverBasePath,
        }),
        getActiveSpace: async (request) =>
          workflows.spacesEnabled
            ? services.getService<SpacesPluginStart>('spaces').spacesService.getActiveSpace(request)
            : undefined,
      },
      unifiedAttachmentTypeRegistry,
      {
        analyticsV2Enabled: workflows.config.analyticsV2.enabled,
        attachmentsEnabled: workflows.config.attachments?.enabled === true,
        templatesEnabled: workflows.config.templates?.enabled === true,
      },
      casesLogger
    );
  },
};
