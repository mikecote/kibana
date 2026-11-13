/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { createVisualizationAttachmentType } from './attachment_types';
import { createVisualizationTool } from './tools/create_visualization';
import { visualizationCreationSkill } from './skills/visualization_creation_skill';

/**
 * What the plugin registers with agent builder: an attachment type, a tool and a skill. Called by
 * `setup()` and by the `agent-builder` contribution to a task process, so both register the same. The
 * SML type is registered with the SML plugin, a registry of its own, and is not part of this.
 */
export const registerVisualizationsAgentBuilder = (agentBuilder: AgentBuilderPluginSetup) => {
  agentBuilder.attachments.registerType(
    createVisualizationAttachmentType() as Parameters<
      typeof agentBuilder.attachments.registerType
    >[0]
  );
  agentBuilder.tools.register(createVisualizationTool());
  agentBuilder.skills.register(visualizationCreationSkill);
};
