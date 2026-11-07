/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { ApmSourcesAccessPluginSetup } from '../plugin';
import { createGetApmIndices } from '../create_get_apm_indices';
import { apmIndicesSavedObjectDefinition } from '../saved_objects/apm_indices';
import {
  APM_SOURCES_TASK_PROCESS_SETTINGS_ID,
  type ApmSourcesTaskProcessSettings,
} from './apm_sources_task_process_settings';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [APM_SOURCES_TASK_PROCESS_SETTINGS_ID],
    savedObjectTypes: [apmIndicesSavedObjectDefinition],
  },
  provides: {
    'apmSourcesAccess.setup': ({ settings }): ApmSourcesAccessPluginSetup => {
      const snapshot = settings[APM_SOURCES_TASK_PROCESS_SETTINGS_ID] as
        | ApmSourcesTaskProcessSettings
        | undefined;
      if (!snapshot) throw new Error('APM sources requires its native configuration snapshot');
      return {
        apmIndicesFromConfigFile: snapshot.indices,
        getApmIndices: createGetApmIndices(() => snapshot.indices),
      };
    },
  },
  register: () => {},
};
