/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { createCustomContentContextAttachmentType } from './attachment_types/custom_content_context';
import { createUpdateCustomContentTool } from './tools/update_custom_content_tool';

/**
 * What the plugin registers with agent builder: an attachment type and a tool. Called by `setup()` and
 * by the `agent-builder` contribution to a task process, so both register the same.
 */
export const registerCustomContentAgentBuilder = (agentBuilder: AgentBuilderPluginSetup) => {
  agentBuilder.attachments.registerType(
    createCustomContentContextAttachmentType() as Parameters<
      typeof agentBuilder.attachments.registerType
    >[0]
  );
  agentBuilder.tools.register(
    createUpdateCustomContentTool() as Parameters<typeof agentBuilder.tools.register>[0]
  );
};
