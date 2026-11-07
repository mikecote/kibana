/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { SIGNIFICANT_EVENT_KI_TYPE } from '@kbn/agent-builder-elastic-ai-index-ki-types';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import { NIGHTSHIFT_ENABLED_FLAG } from '@kbn/nightshift-shared';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { SIGNIFICANT_EVENTS_SEMANTIC_CODE_SEARCH_GROUNDING_ENABLED_FLAG } from '../../common/feature_flags';
import { registerAgentBuilderTools } from '../agent_builder/tools/register_tools';
import { registerAgentBuilderAttachments } from '../agent_builder/attachments/register_attachments';
import { registerAgentBuilderSmlTypes } from '../agent_builder/sml/register_sml_types';
import { createSignificantEventsSkillDefinitions } from '../agent_builder/skills/register_skills';
import { createSignificantEventsAvailability } from '../agent_builder/tools/significant_events_availability';
import {
  SIGNIFICANT_EVENTS_DISCOVERY_AGENT_TYPE_ID,
  registerSignificantEventsDiscoveryAgentTypes,
  installDiscoveryAgents,
} from '../agent_builder/agents/discovery';
import {
  FEATURE_IDENTIFICATION_AGENT_TYPE_ID,
  registerSignificantEventsFeatureIdentificationAgentTypes,
  installFeatureIdentificationAgent,
} from '../agent_builder/agents/feature_identification';
import {
  KI_QUERY_GENERATION_AGENT_TYPE_ID,
  registerSignificantEventsKIQueryGenerationAgentTypes,
  installKIQueryGenerationAgent,
} from '../agent_builder/agents/ki_query_generation';
import { isSignificantEventsSemanticCodeSearchGroundingEnabled } from '../lib/semantic_code_search_grounding/is_significant_events_semantic_code_search_grounding_enabled';
import { knowledgeIndicatorsDataStream } from '../lib/knowledge_indicators';
import { detectionsDataStream } from '../lib/significant_events/detections';
import { sourceKnowledgeStateSavedObjectType } from '../lib/knowledge_indicators/source_knowledge_state';
import { getSignificantEventsMaintenanceStateSavedObjectType } from '../lib/maintenance/saved_object';
import { getRelayAppConnectionSavedObjectType } from '../lib/slack_app/saved_object';
import { runQuotaLedgerSavedObjectType, runQuotaSettingsSavedObjectType } from '../lib/run_quotas';
import { registerSignificantEventsAnalyticsEventTypes } from '../lib/telemetry/ebt/service';
import {
  getSignificantEventsUiSettings,
  getSignificantEventsGlobalUiSettings,
} from '../get_ui_settings';
import { getSignificantEventsTaskProcessServices } from './create_significant_events_task_process_services';
import {
  SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID,
  type SignificantEventsTaskProcessSettings,
} from './significant_events_task_process_settings';

export const contribution: AgentBuilderContribution = {
  declares: {
    settings: [SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID],
    dataStreams: [detectionsDataStream, knowledgeIndicatorsDataStream],
    savedObjectTypes: [
      sourceKnowledgeStateSavedObjectType,
      getSignificantEventsMaintenanceStateSavedObjectType(),
      getRelayAppConnectionSavedObjectType(),
      runQuotaSettingsSavedObjectType,
      runQuotaLedgerSavedObjectType,
    ],
    uiSettings: [getSignificantEventsUiSettings()],
    globalUiSettings: [getSignificantEventsGlobalUiSettings()],
    featureFlags: {
      [NIGHTSHIFT_ENABLED_FLAG]: false,
      [SIGNIFICANT_EVENTS_SEMANTIC_CODE_SEARCH_GROUNDING_ENABLED_FLAG]: false,
    },
    registerAnalyticsEventTypes: registerSignificantEventsAnalyticsEventTypes,
  },
  register: (agentBuilder, context) => {
    const snapshot = context.settings[SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID] as
      | SignificantEventsTaskProcessSettings
      | undefined;
    if (!snapshot) return;
    const runtime = getSignificantEventsTaskProcessServices(context);
    const { registrations } = snapshot;
    registerAgentBuilderTools({
      agentBuilder,
      getScopedClients: runtime.getScopedClients,
      server: runtime.server,
      assertAccess: () => runtime.access.assertAccess(),
      toolIds: registrations.toolIds,
      logger: context.logger,
      telemetry: runtime.telemetry,
    });
    registerAgentBuilderAttachments({
      agentBuilder,
      getScopedClients: runtime.getScopedClients,
      server: runtime.server,
      attachmentTypeIds: registrations.attachmentTypeIds,
      logger: context.logger,
    });
    if (registrations.agentTypeIds.includes(SIGNIFICANT_EVENTS_DISCOVERY_AGENT_TYPE_ID)) {
      registerSignificantEventsDiscoveryAgentTypes({ agentBuilder });
    }
    if (registrations.agentTypeIds.includes(FEATURE_IDENTIFICATION_AGENT_TYPE_ID)) {
      registerSignificantEventsFeatureIdentificationAgentTypes({ agentBuilder });
    }
    if (registrations.agentTypeIds.includes(KI_QUERY_GENERATION_AGENT_TYPE_ID)) {
      registerSignificantEventsKIQueryGenerationAgentTypes({
        agentBuilder,
        isSemanticCodeSearchGroundingEnabled: () => {
          const { featureFlags } = context.host as TaskHost;
          if (!featureFlags) throw new Error('Significant events requires native feature flags');
          return isSignificantEventsSemanticCodeSearchGroundingEnabled(featureFlags);
        },
      });
    }
    if (registrations.smlTypeIds.includes(SIGNIFICANT_EVENT_KI_TYPE)) {
      registerAgentBuilderSmlTypes({
        agentBuilderSml: { registerType: context.registerSmlType },
        getScopedClients: runtime.getScopedClients,
        isAvailable: runtime.access.isAvailable,
      });
    }
  },
  registerAtStart: async (start, context) => {
    const snapshot = context.settings[SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID] as
      | SignificantEventsTaskProcessSettings
      | undefined;
    if (!snapshot) return;
    const runtime = getSignificantEventsTaskProcessServices(context);
    const availability = createSignificantEventsAvailability({
      assertAccess: () => runtime.access.assertAccess(),
      logger: context.logger,
    });
    const skills = createSignificantEventsSkillDefinitions({
      telemetry: runtime.telemetry,
      streamsKIsOnboardingClient: runtime.workflowClients.streamsKIsOnboardingClient,
      maintenanceService: runtime.maintenanceService,
      getScopedClients: runtime.getScopedClients,
      server: runtime.server,
      logger: context.logger,
    });
    await Promise.all([
      installDiscoveryAgents({ agentBuilder: start, spaceId: DEFAULT_SPACE_ID, availability }),
      installFeatureIdentificationAgent({
        agentBuilder: start,
        spaceId: DEFAULT_SPACE_ID,
        availability,
      }),
      installKIQueryGenerationAgent({
        agentBuilder: start,
        spaceId: DEFAULT_SPACE_ID,
        availability,
      }),
      ...skills
        .filter(({ id }) => snapshot.registrations.skillIds.includes(id))
        .map((skill) => start.skills.register({ ...skill, availability })),
    ]);
  },
};
