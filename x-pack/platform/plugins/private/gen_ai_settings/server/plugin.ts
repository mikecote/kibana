/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, CoreStart, Plugin } from '@kbn/core/server';
import type { Logger, PluginInitializerContext } from '@kbn/core/server';
import { AGENT_BUILDER_PRE_PROMPT_WORKFLOW_IDS } from '@kbn/management-settings-ids';
import { schema } from '@kbn/config-schema';
import { registerServerRoutes } from './routes/register_routes';
import type {
  GenAiSettingsPluginSetupDependencies,
  GenAiSettingsPluginStartDependencies,
} from './types';
import type { GenAiSettingsRouteHandlerResources } from './routes/types';
import { getGenAiUiSettings } from './ui_settings';

export type GenAiSettingsPluginSetup = Record<string, never>;
export type GenAiSettingsPluginStart = Record<string, never>;

export class GenAiSettingsPlugin
  implements
    Plugin<
      GenAiSettingsPluginSetup,
      GenAiSettingsPluginStart,
      GenAiSettingsPluginSetupDependencies,
      GenAiSettingsPluginStartDependencies
    >
{
  private readonly logger: Logger;

  constructor(initContext: PluginInitializerContext) {
    this.logger = initContext.logger.get();
  }

  public setup(
    core: CoreSetup<GenAiSettingsPluginStartDependencies>,
    plugins: GenAiSettingsPluginSetupDependencies
  ): GenAiSettingsPluginSetup {
    const routeHandlerPlugins: Pick<
      GenAiSettingsRouteHandlerResources['plugins'],
      'actions' | 'inference' | 'agentBuilderPlatform'
    > = {
      actions: {
        setup: plugins.actions,
        start: () => core.getStartServices().then(([, starts]) => starts.actions),
      },
      inference: {
        setup: plugins.inference,
        start: () => core.getStartServices().then(([, starts]) => starts.inference),
      },
      ...(plugins.agentBuilderPlatform
        ? {
            agentBuilderPlatform: {
              start: () =>
                core.getStartServices().then(([, starts]) => starts.agentBuilderPlatform!),
            },
          }
        : {}),
    };

    const withCore = {
      ...routeHandlerPlugins,
      core: {
        setup: core,
        start: () => core.getStartServices().then(([coreStart]) => coreStart),
      },
    } as GenAiSettingsRouteHandlerResources['plugins'];

    registerServerRoutes({
      core,
      logger: this.logger,
      dependencies: {
        plugins: withCore,
      },
      isDev: false,
    });

    core.uiSettings.register(
      getGenAiUiSettings(async (request) => {
        const [, startServices] = await core.getStartServices();
        return startServices.actions.getActionsClientWithRequest(request);
      })
    );

    core.uiSettings.register({
      [AGENT_BUILDER_PRE_PROMPT_WORKFLOW_IDS]: {
        readonlyMode: 'ui',
        readonly: true,
        schema: schema.arrayOf(schema.string(), { maxSize: 100 }),
        value: [],
      },
    });

    return {};
  }

  public start(core: CoreStart): GenAiSettingsPluginStart {
    return {};
  }

  public stop() {}
}
