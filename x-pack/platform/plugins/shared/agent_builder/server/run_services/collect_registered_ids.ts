/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type {
  AgentBuilderContribution,
  AgentBuilderContributionServices,
} from '@kbn/agent-builder-server';
import { configSchema } from '../config';
import { createAgentBuilderRunServices } from './create_agent_builder_run_services';
import type { RegistrationKind } from './registration_recorder';

const unavailable = (what: string) => () => {
  throw new Error(`${what} is not available while collecting the registered ids`);
};

/**
 * The ids the registries of agent builder hold once the plugin and the given contributions have
 * registered, without starting anything: what a process with these contributions registers, and what a
 * Kibana whose plugins all contribute would send as its parity. Used by tests (the checked-in list of
 * ids, and the integration tests of a process, which send it as what Kibana registered).
 *
 * `settings` is what Kibana would send: a contribution whose plugin sent none registers nothing.
 */
export const collectRegisteredIds = async ({
  contributions,
  settings,
  logger,
  host = { http: { basePath: { get: () => '' } } },
}: {
  contributions: AgentBuilderContribution[];
  settings: Record<string, unknown>;
  logger: Logger;
  /** What the contributions read of the host while registering. */
  host?: unknown;
}): Promise<Record<RegistrationKind, string[]>> => {
  const services = createAgentBuilderRunServices({
    config: configSchema.validate({}, { dev: false }),
    logger,
    // As in a process: the management API is there (its methods throw when used).
    workflowsManagement: { management: {} } as never,
    actions: {} as never,
    getActionsStart: unavailable('The actions plugin') as never,
    getInferenceStart: unavailable('The inference plugin') as never,
    getCoreStart: unavailable('Core') as never,
    taskProcess: { registerSettings: () => {} },
  });
  const contributionServices: AgentBuilderContributionServices = {
    getCoreStart: unavailable('Core') as never,
    getActionsStart: unavailable('The actions plugin') as never,
    getActionsClientWithRequest: unavailable('The actions client') as never,
    getInferenceStart: unavailable('The inference plugin') as never,
    emitEvent: unavailable('Emitting workflow events') as never,
    getWorkflowsManagement: () => ({}),
    getAgentBuilderStart: unavailable('The agent builder start contract') as never,
  };
  for (const contribution of contributions) {
    await contribution.register(services.setupContract, {
      host,
      logger,
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings,
      services: contributionServices,
      registerSmlType: (definition: { id: string }) =>
        services.registrations.recordSmlType(definition.id),
    });
  }
  return services.registrations.ids();
};
