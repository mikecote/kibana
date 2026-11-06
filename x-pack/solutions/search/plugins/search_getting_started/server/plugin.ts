/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  Plugin,
  PluginInitializerContext,
  Logger,
} from '@kbn/core/server';
import type { SearchGettingStartedSetupDependencies } from './types';
import { registerSearchSkills } from './skills/register_search_skills';
import { SEARCH_GETTING_STARTED_AGENT_BUILDER_SETTINGS_ID } from './task_types/agent_builder_contribution';

export class SearchGettingStartedPlugin
  implements Plugin<{}, {}, SearchGettingStartedSetupDependencies>
{
  private readonly logger: Logger;

  constructor(initContext: PluginInitializerContext) {
    this.logger = initContext.logger.get();
  }

  public setup(_core: CoreSetup, plugins: SearchGettingStartedSetupDependencies) {
    if (plugins.agentBuilder) {
      // What a task process needs to register what this Kibana registers: the plugin is enabled.
      plugins.agentBuilder.taskProcess?.registerSettings(
        SEARCH_GETTING_STARTED_AGENT_BUILDER_SETTINGS_ID,
        () => ({})
      );
      registerSearchSkills({ agentBuilder: plugins.agentBuilder, logger: this.logger });
    } else {
      this.logger.debug(
        'Agent Builder plugin is not available, skipping search skills registration'
      );
    }
    return {};
  }

  public start(_core: CoreStart) {
    return {};
  }
}
