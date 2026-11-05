/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { AttachImpactStepId } from '../../common/impact/step_types/attach_impact_step';
import { GetImpactStepId } from '../../common/impact/step_types/get_impact_step';
import { ReopenInvestigationStepId } from '../../common/investigations/step_types/reopen_investigation_step';
import { AppendWorkflowExecutionIdStepId } from '../../common/workflow_execution/step_types/append_workflow_execution_id_step';

/**
 * The steps of this plugin in the task process of the workflow task types: none is served, so the
 * plugin has no `workflow-steps` contribution and a workflow that uses one is declined (the
 * pre-flight finds the step type missing) and Kibana runs it. Every step reads or writes the
 * investigation conversation with Agent Builder's conversation client (the access check of the
 * request, the attachments and the workflow execution ids of the conversation), which needs the
 * registries that other plugins fill in their `setup()`: the built-in agents, the attachment types
 * and the conversation templates. A process would serve them with empty registries and behave
 * differently from Kibana.
 */
export const KIBANA_ONLY_INVESTIGATION_STEPS: Record<string, string> = {
  [AttachImpactStepId]:
    "attaches the impact to the conversation with Agent Builder's attachment and conversation clients",
  [GetImpactStepId]:
    "checks the conversation access of the request with Agent Builder's conversation client",
  [ReopenInvestigationStepId]:
    "reads and updates the investigation conversation with Agent Builder's conversation client",
  [AppendWorkflowExecutionIdStepId]:
    "updates the workflow execution ids of the conversation with Agent Builder's conversation client",
};
