/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { join } from 'path';
import { REPO_ROOT } from '@kbn/repo-info';
import { platformSignificantEventsTools } from '@kbn/agent-builder-common';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';

const CASES_EXAMPLE = {
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
    attachmentTypeIds: [
      'file',
      'lens',
      'comment',
      'stack.alert',
      'dashboard',
      'map',
      'discoverSession',
    ],
  },
};

/**
 * Settings of the contributions that need more than "the plugin is enabled", for the tests that send
 * what Kibana would with every plugin enabled (the checked-in ids, the integration tests of a
 * process). A contribution that is not listed gets `{}`.
 */
const EXAMPLES: Record<string, unknown> = {
  nightshiftInvestigations: {
    workflowsManagementAvailable: true,
    decisionTreesEnabled: true,
    cortexEnabled: true,
    memoryEnabled: true,
    sandboxAvailable: true,
    agentBuilderAvailable: true,
    agenticInvestigationsAvailable: true,
    proposalsAvailable: true,
  },
  alertzeroAgentBuilderRuntime: { actionsAvailable: true, managementAvailable: true },
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
  casesAgentBuilder: CASES_EXAMPLE,
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
): Record<string, unknown> => {
  const settings = Object.fromEntries(
    contributions.flatMap(({ declares }) =>
      (declares?.settings ?? []).map((id) => [id, EXAMPLES[id] ?? {}])
    )
  );
  if ('casesAgentBuilder' in settings) {
    const { getRuleReadSettings } = jest.requireActual<{
      getRuleReadSettings: (registry: { list: () => Map<string, never> }) => object;
    }>(
      join(
        REPO_ROOT,
        'x-pack/platform/plugins/shared/alerting/server/task_types/rule_read_contribution'
      )
    );
    settings.alertingRuleRead = getRuleReadSettings({ list: () => new Map<string, never>() });
    const { getAlertingAuthorizationTaskProcessSettings } = jest.requireActual<{
      getAlertingAuthorizationTaskProcessSettings: (options: {
        ruleTypeRegistry: { list: () => Map<string, { id: string }> };
        features: { getKibanaFeatures: () => [] };
        spacesEnabled: boolean;
        securityEnabled: boolean;
      }) => object;
    }>(
      join(
        REPO_ROOT,
        'x-pack/platform/plugins/shared/alerting/server/task_types/alerting_authorization_task_process_settings'
      )
    );
    settings.alertingAuthorizationRuntime = getAlertingAuthorizationTaskProcessSettings({
      ruleTypeRegistry: { list: () => new Map() },
      features: { getKibanaFeatures: () => [] },
      spacesEnabled: true,
      securityEnabled: true,
    });
    const { ConfigSchema } = jest.requireActual<{
      ConfigSchema: { validate: (value: object) => object };
    }>(join(REPO_ROOT, 'x-pack/platform/plugins/shared/cases/server/config'));
    settings.casesAgentBuilder = {
      workflows: {
        ...CASES_EXAMPLE.workflows,
        config: ConfigSchema.validate(CASES_EXAMPLE.workflows.config),
      },
    };
  }
  if ('embeddableRuntime' in settings) {
    const { createEmbeddableExampleSettings } = jest.requireActual<{
      createEmbeddableExampleSettings: () => Record<string, object>;
    }>(
      join(
        REPO_ROOT,
        'src/platform/plugins/shared/embeddable/server/task_process/example_settings.mock'
      )
    );
    Object.assign(settings, createEmbeddableExampleSettings());
  }
  if ('securitySolutionAgentBuilder' in settings) {
    // Load the owning fixture dynamically to keep a platform-to-solution project cycle out of production.
    const { createSecurityAgentBuilderExampleSettings } = jest.requireActual<{
      createSecurityAgentBuilderExampleSettings: () => Record<string, object>;
    }>(
      join(
        REPO_ROOT,
        'x-pack/solutions/security/plugins/security_solution/server/task_types/agent_builder_example_settings.mock'
      )
    );
    Object.assign(settings, createSecurityAgentBuilderExampleSettings());
  }
  return settings;
};
