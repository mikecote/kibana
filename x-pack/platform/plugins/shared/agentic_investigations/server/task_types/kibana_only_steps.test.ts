/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowsExtensionsServerPluginSetup } from '@kbn/workflows-extensions/server';
import { registerImpactStepDefinitions } from '../impact/step_types';
import { registerInvestigationStepDefinitions } from '../investigations/step_types';
import { registerWorkflowExecutionStepDefinitions } from '../workflow_execution/step_types';
import { KIBANA_ONLY_INVESTIGATION_STEPS } from './kibana_only_steps';

describe('steps of the agentic investigations plugin in a task process', () => {
  it('classifies every step Kibana registers as one that only Kibana serves', () => {
    const ids: string[] = [];
    const workflowsExtensions = {
      registerStepDefinition: (definition: { id: string }) => ids.push(definition.id),
    } as unknown as WorkflowsExtensionsServerPluginSetup;
    const getConversationClient = jest.fn();

    registerImpactStepDefinitions({
      workflowsExtensions,
      getImpactService: jest.fn(),
      resolveUser: jest.fn(),
      privileges: {} as never,
      getAttachmentClient: jest.fn(),
      getConversationClient,
    });
    registerInvestigationStepDefinitions({
      workflowsExtensions,
      getInvestigationStatusService: jest.fn(),
      getConversationClient,
    });
    registerWorkflowExecutionStepDefinitions({ workflowsExtensions, getConversationClient });

    expect(ids).toHaveLength(4);
    expect([...ids].sort()).toEqual(Object.keys(KIBANA_ONLY_INVESTIGATION_STEPS).sort());
  });
});
