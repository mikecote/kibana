/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * The steps `plugin.ts` registers that the task process of the workflow task types does not: a
 * workflow that uses one is declined and Kibana runs it. Each needs a service that only Kibana
 * has, with the reason.
 */
export const KIBANA_ONLY_NIGHTSHIFT_STEPS: Record<string, string> = {
  'nightshift.triggerInvestigation':
    'the investigations client reads the agents, tools and availability that Agent Builder and the plugins around it register in setup()',
  'nightshift.ensureInvestigationAgent':
    "installs the investigation agent with Agent Builder's agents service, which holds the registrations of other plugins",
  'nightshift.sendNotifications':
    "needs the investigations client and the notification routing, which reads the conversation with Agent Builder's attachment and conversation clients",
  'nightshift.handleInvestigationFailure':
    'needs the investigations client and the notification routing of Agent Builder, like sendNotifications',
  'nightshift.renderSlackMessage':
    'needs the investigations client, which depends on what Agent Builder registers',
  'nightshift.obtainSandbox':
    "needs the sandbox plugin's start contract, which a process cannot have",
  'nightshift.cortexHydrate':
    "needs the sandbox plugin's start contract, which a process cannot have",
  'nightshift.memoryMaterializeToSandbox':
    "needs the sandbox plugin's start contract, which a process cannot have",
  'nightshift.decisionTreeHydrate':
    "needs the sandbox plugin's start contract, which a process cannot have",
  'nightshift.cortexOptimize':
    "runs an agent with Agent Builder's execution service and the agents it registers",
  'nightshift.memoryOptimize':
    "runs an agent with Agent Builder's execution service and the agents it registers",
  'nightshift.decisionTreeReinforce':
    "runs the reinforcement agent with Agent Builder's execution service",
};
