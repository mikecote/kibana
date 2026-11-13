/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import { contribution } from './workflow_steps_contribution';
import { registerConnectorEventTriggers } from '../triggers/register_connector_event_triggers';

const register = async (settings: Record<string, unknown>) => {
  const registry = createServerStepRegistry(loggerMock.create());
  const internal = registry.getAllTriggerDefinitions().length;
  await contribution.register(registry, {
    host: {},
    logger: loggerMock.create(),
    isServerless: false,
    kibanaVersion: '1.0.0',
    settings,
  });
  return { registry, added: registry.getAllTriggerDefinitions().length - internal };
};

describe('workflows_management workflow-steps contribution', () => {
  it('registers the connector event triggers Kibana registers when inbound events are enabled', async () => {
    const kibana: string[] = [];
    registerConnectorEventTriggers({
      inboundEventsEnabled: true,
      registerTriggerDefinition: (definition) => kibana.push(definition.id),
    });
    expect(kibana.length).toBeGreaterThan(0);

    const { registry, added } = await register({ actions: { inboundEvents: { enabled: true } } });
    expect(added).toBe(kibana.length);
    kibana.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
  });

  it('registers none when inbound events are disabled', async () => {
    expect((await register({ actions: { inboundEvents: { enabled: false } } })).added).toBe(0);
    expect((await register({})).added).toBe(0);
  });
});
