/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsType } from '@kbn/core/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerStreamsSavedObjects } from '../lib/saved_objects/register_saved_objects';
import { STREAMS_AGENT_BUILDER_SETTINGS_ID } from './agent_builder_contribution';
import type { StreamsAgentBuilderSettings } from './agent_builder_contribution';

export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [STREAMS_AGENT_BUILDER_SETTINGS_ID],
    createSavedObjectTypes: (encryptedSavedObjects, settings) => {
      const snapshot = settings[STREAMS_AGENT_BUILDER_SETTINGS_ID] as
        | StreamsAgentBuilderSettings
        | undefined;
      const types: SavedObjectsType[] = [];
      registerStreamsSavedObjects(
        { registerType: (type) => types.push(type) },
        {
          isStreamsCanvasEnabled: snapshot?.canvasEnabled === true,
          encryptedSavedObjects,
        }
      );
      return types;
    },
  },
  register: () => {},
};
