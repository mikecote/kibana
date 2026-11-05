/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { registerAgentBuilderProcessWorkflowDefinitions } from '../workflows';

/**
 * The workflow triggers and steps of Agent Builder in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`.
 *
 * Registered: the triggers (definitions only) and the `rerank` step, which only needs the scoped
 * Elasticsearch client of the run.
 *
 * Deliberately not registered, so a workflow that uses one is declined and Kibana runs it:
 * - `runAgent`, the conversation steps (`create_conversation`, `get/update_conversation_metadata`,
 *   `add_conversation_event`, `add_user_message`) and the attachment steps (`add`, `update`,
 *   `delete`, `read`, `list`). They read registries that other plugins fill in their `setup()`, which a
 *   process does not run: the built-in agents (conversation access checks and agent lookups), the
 *   attachment types (validation, defaults, staleness), conversation templates, tools, skills and
 *   plugins. A process would serve them with empty registries and behave differently from Kibana.
 *   `runAgent` and `add_user_message` also run the agent execution loop with those tools.
 *   Onboarding them needs a contribution mechanism for those registries.
 */
export const contribution: WorkflowStepsContribution = {
  register: (registry) => {
    registerAgentBuilderProcessWorkflowDefinitions(registry);
  },
};
