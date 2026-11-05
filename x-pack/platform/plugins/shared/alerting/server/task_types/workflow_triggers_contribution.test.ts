/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { createServerStepRegistry } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import { registerTriggerDefinitions } from '../lib/workflow_extensions/register_trigger_definitions';
import { contribution } from './workflow_triggers_contribution';

describe('alerting workflow-steps contribution', () => {
  it('registers the triggers Kibana registers', async () => {
    const kibana: string[] = [];
    registerTriggerDefinitions({
      registerTriggerDefinition: (definition: { id: string }) => kibana.push(definition.id),
    } as unknown as WorkflowStepsRegistry);
    expect(kibana.length).toBeGreaterThan(0);

    const registry = createServerStepRegistry(loggerMock.create());
    await contribution.register(registry, {
      host: {},
      logger: loggerMock.create(),
      isServerless: false,
      kibanaVersion: '1.0.0',
      settings: {},
    });
    kibana.forEach((id) => expect(registry.getTriggerDefinition(id)).toBeDefined());
  });
});
