/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { ObservabilityAgentBuilderRunSetupDependencies } from '../types';
import { createInvestigationSkill } from './investigation';

export const registerSkills = ({
  plugins,
  logger,
  skillIds,
  onRegistered,
}: {
  plugins: ObservabilityAgentBuilderRunSetupDependencies;
  logger: Logger;
  skillIds?: readonly string[];
  onRegistered?: (id: string) => void;
}) => {
  const skill = createInvestigationSkill();
  if (skillIds && !skillIds.includes(skill.id)) return;
  plugins.agentBuilder.skills.register(skill);
  onRegistered?.(skill.id);
  logger.debug('Successfully registered observability skills in agent-builder');
};
