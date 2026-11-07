/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import { registerAttachments } from './register_attachments';
import { registerSkill } from './register_skill';
import { registerTools } from './register_tools';

/**
 * What Discover registers with agent builder: attachment types, a tool and skills. Called by
 * `setup()` and by the `agent-builder` contribution to a task process, so both register the same.
 */
export const registerDiscoverAgentBuilder = (agentBuilder: AgentBuilderPluginSetup) => {
  registerAttachments(agentBuilder);
  registerTools(agentBuilder);
  registerSkill(agentBuilder);
};
