/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createSourcesClient } from '../create_sources_client';
import { createSourceChangeEmitter } from '../lib/source_change_emitter';
import { nightshiftSourceSavedObjectType } from '../saved_objects/nightshift_source_saved_object';
import type { NightshiftSourcesServerSetup, NightshiftSourcesServerStart } from '../types';

export const contribution: WorkflowStepsContribution = {
  declares: {
    savedObjectTypes: [nightshiftSourceSavedObjectType],
    settings: ['nightshiftSourcesRuntime'],
  },
  provides: {
    nightshiftSources: ({
      host: taskHost,
      settings,
    }): NightshiftSourcesServerSetup & NightshiftSourcesServerStart => {
      const snapshot = settings.nightshiftSourcesRuntime as { enabled: boolean } | undefined;
      if (!snapshot?.enabled)
        throw new Error('Nightshift source services are not enabled in this Kibana');
      const host = taskHost as TaskHost;
      const logger = host.logger.get('nightshiftSources');
      const emitter = createSourceChangeEmitter(logger.get('source-changes'));
      return {
        onSourceChange: emitter.subscribe,
        getSourcesClient: async ({ request }) =>
          createSourcesClient(
            {
              savedObjects: host.savedObjects,
              elasticsearch: { client: host.elasticsearch },
              security: host.security,
            },
            request,
            logger.get('sources'),
            emitter
          ),
      };
    },
  },
  register: () => {},
};
