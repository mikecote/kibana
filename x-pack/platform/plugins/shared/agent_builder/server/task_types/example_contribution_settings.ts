/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformSignificantEventsTools } from '@kbn/agent-builder-common';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';

/**
 * Settings of the contributions that need more than "the plugin is enabled", for the tests that send
 * what Kibana would with every plugin enabled (the checked-in ids, the integration tests of a
 * process). A contribution that is not listed gets `{}`.
 */
const EXAMPLES: Record<string, unknown> = {
  observabilityAgentBuilderRuntime: {
    registrations: {
      toolIds: [
        'observability.get_alerts',
        'observability.get_anomaly_detection_jobs',
        'observability.get_apm_correlations',
        'observability.get_hosts',
        'observability.get_index_info',
        'observability.get_log_change_points',
        'observability.get_log_groups',
        'observability.get_logs',
        'observability.get_metric_change_points',
        'observability.get_runtime_metrics',
        'observability.get_service_topology',
        'observability.get_services',
        'observability.get_trace_change_points',
        'observability.get_trace_metrics',
        'observability.get_traces',
        'observability.run_log_rate_analysis',
      ],
      attachmentTypeIds: [
        'observability.ai_insight',
        'observability.alert',
        'observability.error',
        'observability.host',
        'observability.log',
        'observability.service',
        'observability.slo',
        'observability.synthetics_monitor',
        'observability.transaction',
      ],
      skillIds: ['observability.investigation'],
    },
    dataProviders: [],
    mlEnabled: true,
    spacesEnabled: true,
  },
  agenticInvestigationsRuntime: {
    escalationsEnabled: true,
    securityEnabled: true,
    spacesEnabled: true,
    proposalsEnabled: true,
  },
  significantEvents: {
    cpsEnabled: false,
    availability: {
      deploymentSupported: true,
      pricingTierAvailable: true,
      requiredPlugins: ['agentBuilder', 'workflowsExtensions', 'workflowsManagement'],
    },
    registrations: {
      toolIds: Object.values(platformSignificantEventsTools),
      attachmentTypeIds: [
        'platform.sig_event',
        'platform.ki_feature',
        'platform.sig_event_detection',
      ],
      agentTypeIds: [
        'platform.sig_events.discovery-type',
        'platform.sig_events.feature-identification-type',
        'platform.sig_events.ki-query-generation-type',
      ],
      skillIds: [
        'knowledge-indicators-management',
        'ki-query-generation',
        'significant-events-ki-grounding',
        'significant-events-management',
        'feature-identification',
        'ki-identification-management',
        'streams-investigation-management',
      ],
      smlTypeIds: ['significant_event'],
    },
  },
  discoveries: {
    connectorTimeout: 60_000,
    agentBuilder: {
      attachmentTypeIds: [
        'security.attack_discovery',
        'diagnostic_report',
        'security.attack_discovery.verdict',
      ],
      skillIds: [
        'attack-discovery-alert-retrieval-builder',
        'attack-discovery-generator',
        'attack-discovery-workflow-troubleshooting',
      ],
    },
  },
  alertingV2Runtime: { agentBuilderEnabled: true, smlEnabled: true },
  contextEngineManagedAiIndices: { registrations: [] },
  casesAgentBuilder: {
    workflows: {
      config: {
        analyticsV2: { enabled: true },
        attachments: { enabled: true },
        templates: { enabled: true },
        assigneeIdentity: { enabled: true },
      },
      spacesEnabled: true,
      featureCaseOwners: [{ id: 'securitySolutionCasesV3', cases: ['securitySolution'] }],
      isEmailServiceAvailable: false,
      hasAlertStatusChangedListeners: false,
      closeReasonOwners: [],
    },
  },
  streamsAgentBuilder: {
    isDev: false,
    canvasEnabled: false,
    canEncrypt: false,
    isServerless: false,
  },
  evalsSkillsAgentBuilder: { serverBasePath: '', isServerless: false },
  mlAgentBuilder: {
    moduleFiles: {},
    enabledFeatures: { ad: true, dfa: true, nlp: true },
    compatibleModuleType: null,
    spacesEnabled: true,
    cpsEnabled: false,
  },
};

export const getExampleContributionSettings = (
  contributions: Array<Pick<AgentBuilderContribution, 'declares'>>
): Record<string, unknown> =>
  Object.fromEntries(
    contributions.flatMap(({ declares }) =>
      (declares?.settings ?? []).map((id) => [id, EXAMPLES[id] ?? {}])
    )
  );
