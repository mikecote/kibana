/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin, PluginInitializerContext } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type {
  EvalsSkillsSetupDependencies,
  EvalsSkillsStartDependencies,
  EvalsSkillsPluginSetup,
  EvalsSkillsPluginStart,
} from './types';
import { registerEvalsSkillsAgentBuilder } from './register_agent_builder';
import { EVALS_SKILLS_AGENT_BUILDER_SETTINGS_ID } from './task_types/agent_builder_contribution';
import type { EvalExperimentsToolDeps } from './skills/eval_experiments/tools/deps';

/**
 * "Glue" plugin that registers evals-domain Agent Builder skills. It depends on
 * both `agentBuilder` and `evals` to avoid a cyclic dependency between them.
 *
 * It has no enabled flag of its own. It follows `xpack.evals.enabled` (off by default).
 */
export class EvalsSkillsPlugin
  implements
    Plugin<
      EvalsSkillsPluginSetup,
      EvalsSkillsPluginStart,
      EvalsSkillsSetupDependencies,
      EvalsSkillsStartDependencies
    >
{
  private readonly logger: Logger;
  private readonly isServerless: boolean;

  constructor(context: PluginInitializerContext) {
    this.logger = context.logger.get();
    this.isServerless = context.env.packageInfo.buildFlavor === 'serverless';
  }

  setup(
    coreSetup: CoreSetup<EvalsSkillsStartDependencies, EvalsSkillsPluginStart>,
    { agentBuilder, workflowsManagement, evals }: EvalsSkillsSetupDependencies
  ): EvalsSkillsPluginSetup {
    if (!evals.enabled) {
      this.logger.debug(
        'The evals feature is disabled; skipping registration of evals Agent Builder skills.'
      );
      return {};
    }

    const getStartDependencies = () =>
      coreSetup.getStartServices().then(([, startDependencies]) => startDependencies);

    const toolDeps: EvalExperimentsToolDeps = {
      workflowsApi: workflowsManagement.management,
      serverBasePath: coreSetup.http.basePath.serverBasePath,
      logger: this.logger,
      getStartDependencies,
    };

    // What a task process needs to register what this Kibana registers: the evals feature is enabled.
    agentBuilder.taskProcess?.registerSettings(EVALS_SKILLS_AGENT_BUILDER_SETTINGS_ID, () => ({
      serverBasePath: toolDeps.serverBasePath,
      isServerless: this.isServerless,
    }));
    registerEvalsSkillsAgentBuilder(agentBuilder, toolDeps);
    this.logger.debug('Registered evals Agent Builder skill(s).');

    return {};
  }

  start(_coreStart: CoreStart, _startDeps: EvalsSkillsStartDependencies): EvalsSkillsPluginStart {
    return {};
  }

  stop() {}
}
