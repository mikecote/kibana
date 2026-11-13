/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-plugin/server';

import type { GetStepServices } from '../../workflows/step_services';
import { alertRetrievalBuilderSkill } from './alert_retrieval_builder';
import { createAttackDiscoveryGeneratorSkill } from './attack_discovery_generator';
import type { WorkflowExecutionLookup } from './tools/get_attack_discovery_status_tool';
import type { WorkflowFetcher } from './tools/get_workflow_health_check_tool';
import type { RunAttackDiscoveryToolDeps } from './tools/run_attack_discovery_tool';
import { createWorkflowTroubleshootingSkill } from './workflow_troubleshooting';

interface RegisterSkillsOptions {
  skillIds?: readonly string[];
  onRegistered?: (id: string) => void;
  getEventLogIndex?: () => Promise<string>;
  getStartServices?: GetStepServices;
  runAttackDiscoveryToolDeps?: RunAttackDiscoveryToolDeps;
  workflowExecutionLookup?: WorkflowExecutionLookup;
  workflowFetcher?: WorkflowFetcher;
}

/**
 * Registers all Attack Discovery agent builder skills with the agentBuilder plugin.
 *
 * Skills registered here become globally available in the agent builder,
 * including from the security_solution context.
 */
export const registerSkills = async (
  agentBuilder: AgentBuilderPluginSetup,
  logger: Logger,
  options?: RegisterSkillsOptions
): Promise<void> => {
  const registerSkill = async (
    skill: Parameters<AgentBuilderPluginSetup['skills']['register']>[0]
  ) => {
    if (options?.skillIds && !options.skillIds.includes(skill.id)) return;
    await agentBuilder.skills.register(skill);
    options?.onRegistered?.(skill.id);
  };
  await registerSkill(alertRetrievalBuilderSkill);

  if (options?.getEventLogIndex != null && options.workflowExecutionLookup != null) {
    await registerSkill(
      createAttackDiscoveryGeneratorSkill({
        getEventLogIndex: options.getEventLogIndex,
        getStartServices: options.getStartServices,
        runAttackDiscoveryToolDeps: options.runAttackDiscoveryToolDeps,
        workflowExecutionLookup: options.workflowExecutionLookup,
      })
    );
  } else {
    logger.debug(
      () =>
        'discoveries: getEventLogIndex or workflowExecutionLookup not provided; skipping attack-discovery-generator skill registration'
    );
  }

  if (options?.workflowFetcher != null) {
    await registerSkill(createWorkflowTroubleshootingSkill(options.workflowFetcher));
  }

  logger.debug(() => 'discoveries: Skills registration complete');
};
