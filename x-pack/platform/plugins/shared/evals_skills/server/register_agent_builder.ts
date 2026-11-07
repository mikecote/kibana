/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { createEvalDatasetManagementSkill } from './skills/eval_dataset_management/skill';
import { createEvalExperimentsSkill } from './skills/eval_experiments/skill';
import type { EvalExperimentsToolDeps } from './skills/eval_experiments/tools/deps';

/**
 * What the evals skills plugin registers with agent builder: the experiments and the dataset
 * management skills. Called by `setup()` and by the task process contribution, with the services each
 * of them builds.
 */
export const registerEvalsSkillsAgentBuilder = (
  agentBuilder: Pick<AgentBuilderPluginSetup, 'skills'>,
  toolDeps: EvalExperimentsToolDeps
) => {
  agentBuilder.skills.register(createEvalExperimentsSkill(toolDeps));
  agentBuilder.skills.register(
    createEvalDatasetManagementSkill({
      logger: toolDeps.logger,
      getStartDependencies: toolDeps.getStartDependencies,
    })
  );
};
