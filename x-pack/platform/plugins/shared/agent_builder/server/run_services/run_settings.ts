/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginInitializerContext } from '@kbn/core/server';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { SearchInferenceEndpointsPluginStart } from '@kbn/search-inference-endpoints/server';
import {
  AGENT_BUILDER_INFERENCE_FEATURE_ID,
  AGENT_BUILDER_FAST_INFERENCE_FEATURE_ID,
} from '@kbn/agent-builder-common/constants';
import { configSchema } from '../config';
import type { AgentBuilderConfig } from '../config';
import { getDeploymentInfo } from '../utils/deployment_info';
import type { DeploymentInfo } from '../utils/deployment_info';

/** The id of the settings Kibana sends a task process for agent builder (`settings[AGENT_BUILDER_RUN_SETTINGS_ID]`). */
export const AGENT_BUILDER_RUN_SETTINGS_ID = 'agentBuilderRun';

/**
 * What the services of agent builder read that Kibana owns or changes while it runs: the part of its
 * config they read, the static deployment information, and the recommended endpoints of the inference
 * features that Kibana's poller keeps up to date (the process has no poller; it takes the snapshot).
 */
export interface AgentBuilderRunSettings {
  config: Pick<AgentBuilderConfig, 'topSnippets' | 'githubBaseUrl'> & {
    deductive?: AgentBuilderConfig['deductive'];
  };
  deploymentInfo: DeploymentInfo;
  /** By inference feature id. */
  recommendedEndpoints: Record<string, string[]>;
}

const RECOMMENDED_ENDPOINTS_FEATURE_IDS = [
  AGENT_BUILDER_INFERENCE_FEATURE_ID,
  AGENT_BUILDER_FAST_INFERENCE_FEATURE_ID,
];

export const getAgentBuilderRunSettings = ({
  config,
  cloud,
  env,
  getSearchInferenceEndpoints,
}: {
  config: AgentBuilderConfig;
  cloud?: CloudSetup;
  env: Pick<PluginInitializerContext['env'], 'packageInfo' | 'airgapped'>;
  getSearchInferenceEndpoints: () => SearchInferenceEndpointsPluginStart | undefined;
}): AgentBuilderRunSettings => {
  const features = getSearchInferenceEndpoints()?.features;
  return {
    config: {
      topSnippets: config.topSnippets,
      githubBaseUrl: config.githubBaseUrl,
      ...(config.deductive ? { deductive: config.deductive } : {}),
    },
    deploymentInfo: getDeploymentInfo({
      cloud,
      packageInfo: env.packageInfo,
      airgapped: env.airgapped,
    }),
    recommendedEndpoints: Object.fromEntries(
      RECOMMENDED_ENDPOINTS_FEATURE_IDS.flatMap((featureId) => {
        const endpoints = features?.get(featureId)?.recommendedEndpoints;
        return endpoints?.length ? [[featureId, [...endpoints]]] : [];
      })
    ),
  };
};

/** The config the services of agent builder are built from, as a process rebuilds it from the settings it was sent. */
export const toAgentBuilderConfig = (
  settings: AgentBuilderRunSettings['config']
): AgentBuilderConfig => configSchema.validate(settings, { dev: false });
