/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup, ToolAvailabilityConfig } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/core/server';
import type { StreamsServer } from '../types';
import type { GetScopedClients } from '../routes/types';

import { registerAgentBuilderTools } from './tools/register_tools';
import { registerAgentBuilderSkills } from './skills/register_skills';

/**
 * What streams registers with agent builder: its tools and skills. Called by `setup()` and by the
 * task process contribution, with the scoped clients of `createStreamsRunServices` and the
 * availability each of them builds from its own services.
 */
export const registerStreamsAgentBuilder = async (
  agentBuilder: AgentBuilderPluginSetup,
  {
    getScopedClients,
    server,
    logger,
    availability,
  }: {
    getScopedClients: GetScopedClients;
    server: Pick<StreamsServer, 'isServerless'>;
    logger: Logger;
    availability: ToolAvailabilityConfig;
  }
): Promise<void> => {
  registerAgentBuilderTools({ agentBuilder, getScopedClients, server, logger, availability });
  registerAgentBuilderSkills({ agentBuilder, availability });
};
