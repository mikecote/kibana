/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AttachmentTypeDefinition } from '@kbn/agent-builder-server/attachments';
import { OnSetup, OnStart, PluginSetup, PluginStart } from '@kbn/core-di';
import { CoreStart } from '@kbn/core-di-server';
import { ALERTING_V2_ENABLED_SETTING_ID } from '@kbn/alerting-v2-constants';
import type { Container, ContainerModuleLoadOptions } from 'inversify';
import { resolveRequestScoped } from '../agent_builder/resolve_request_scoped';
import { registerSkills } from '../agent_builder/skills/register_skills';
import { createAlertingV2Availability } from '../agent_builder/skills/alerting_v2_availability';
import {
  createAlertingV2AttachmentTypes,
  createAlertingV2SmlTypes,
} from '../agent_builder/create_integrations';
import { AttachmentTypeToken } from '../agent_builder/tokens';
import { WorkflowsManagementApiToken } from '../lib/dispatcher/steps/dispatch_step_tokens';
import {
  LoggerServiceToken,
  type LoggerServiceContract,
} from '../lib/services/logger_service/logger_service';
import { UiSettingsClientToken } from '../lib/services/settings_service/tokens';
import type { AlertingServerSetupDependencies, AlertingServerStartDependencies } from '../types';

type AgentBuilderSetup = NonNullable<AlertingServerSetupDependencies['agentBuilder']>;

/**
 * Returns the Agent Builder setup contract, or `undefined` when the optional
 * `agentBuilder` plugin is not available.
 */
function getAgentBuilder(container: Container): AgentBuilderSetup | undefined {
  const token = PluginSetup<AgentBuilderSetup>('agentBuilder');
  return container.isBound(token) ? container.get(token) : undefined;
}

/**
 * Wiring for the Agent Builder integration. No-op when the optional
 * `agentBuilder` plugin is not available.
 *
 * - SML types are registered during setup (synchronously) so the agent context
 *   layer can schedule their crawler tasks during its own start phase. Gated on
 *   the optional `agentBuilderSml` plugin.
 * - Attachment types are bound to {@link AttachmentTypeToken} (deps resolved via
 *   DI) and registered during start. Skills are registered alongside them.
 *
 * Both resolve request-scoped clients on demand via {@link resolveRequestScoped},
 * since they run outside the HTTP route scope.
 */
export function bindAgentBuilder({ bind }: ContainerModuleLoadOptions) {
  const attachmentTypesToken = Symbol('alertingVTwo.attachmentTypes');
  bind<AttachmentTypeDefinition[]>(attachmentTypesToken)
    .toResolvedValue(
      (loggerService: LoggerServiceContract, injection) =>
        createAlertingV2AttachmentTypes({
          logger: loggerService.forSubsystem('agentBuilder'),
          resolve: (request, token) => resolveRequestScoped(injection, request, token),
        }),
      [LoggerServiceToken, CoreStart('injection')]
    )
    .inSingletonScope();
  for (const index of [0, 1, 2]) {
    bind(AttachmentTypeToken).toResolvedValue(
      (types: AttachmentTypeDefinition[]) => types[index],
      [attachmentTypesToken]
    );
  }

  bind(OnSetup).toConstantValue((container) => {
    if (!getAgentBuilder(container)) {
      return;
    }

    const agentBuilderSmlToken =
      PluginSetup<NonNullable<AlertingServerSetupDependencies['agentBuilderSml']>>(
        'agentBuilderSml'
      );
    if (!container.isBound(agentBuilderSmlToken)) {
      return;
    }

    const agentBuilderSml = container.get(agentBuilderSmlToken);

    // Resolved lazily at crawl time (start phase) so the SML hooks reflect the
    // current value of the `alerting:v2:enabled` global advanced setting on
    // every crawl, rather than a value captured once at setup.
    const getIsAlertingV2Enabled = () =>
      container.get(UiSettingsClientToken).get<boolean>(ALERTING_V2_ENABLED_SETTING_ID);

    // SML types are registered inline (not via a token registry like attachments):
    // registration happens at setup, but their clients must be resolved lazily at
    // crawl time (start phase), so deps cannot be eagerly injected at bind time.
    for (const definition of createAlertingV2SmlTypes({
      resolve: (request, token) =>
        resolveRequestScoped(container.get(CoreStart('injection')), request, token),
      getIsAlertingV2Enabled,
    })) {
      agentBuilderSml.registerType(definition);
    }
  });

  bind(OnStart).toConstantValue((container) => {
    const agentBuilder = getAgentBuilder(container);
    if (!agentBuilder) {
      return;
    }

    for (const attachmentType of container.getAll(AttachmentTypeToken)) {
      agentBuilder.attachments.registerType(attachmentType);
    }

    const workflowsManagementApi = container.get(WorkflowsManagementApiToken);
    const agentBuilderLogger = container.get(LoggerServiceToken).forSubsystem('agentBuilder');
    const spaces = container.get(PluginStart<AlertingServerStartDependencies['spaces']>('spaces'));
    const cloudToken = PluginSetup<NonNullable<AlertingServerSetupDependencies['cloud']>>('cloud');
    const projectType = container.isBound(cloudToken)
      ? container.get(cloudToken).serverless.projectType
      : undefined;
    registerSkills(agentBuilder, {
      logger: agentBuilderLogger,
      getWorkflowClient: (request) => workflowsManagementApi.getClient(request),
      getAvailableConnectors: (sid, req) => workflowsManagementApi.getAvailableConnectors(sid, req),
      availability: createAlertingV2Availability({
        getActiveSpace: (request) => spaces.spacesService.getActiveSpace(request),
        projectType,
      }),
      validateWorkflow: (yaml, sid, req) => workflowsManagementApi.validateWorkflow(yaml, sid, req),
    });
  });
}
