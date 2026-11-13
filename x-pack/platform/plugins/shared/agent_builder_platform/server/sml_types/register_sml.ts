/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { AgentBuilderSmlPluginSetup } from '@kbn/agent-builder-sml-plugin/server';
import { createConnectorSmlType } from './connector';

/**
 * What the plugin registers with the SML plugin: the connector type. Called by `setup()` and by the
 * `agent-builder` contribution to a task process (with `registerType` of its context).
 */
export const registerAgentBuilderPlatformSml = (
  sml: Pick<AgentBuilderSmlPluginSetup, 'registerType'>,
  {
    getCoreStart,
    logger,
  }: { getCoreStart: () => Promise<Pick<CoreStart, 'savedObjects'>>; logger: Logger }
) => {
  sml.registerType(
    createConnectorSmlType({
      getActionSavedObjectsClient: async (request) => {
        const coreStart = await getCoreStart();
        return coreStart.savedObjects.getScopedClient(request, { includedHiddenTypes: ['action'] });
      },
      logger: logger.get('sml-connector'),
    })
  );
};
