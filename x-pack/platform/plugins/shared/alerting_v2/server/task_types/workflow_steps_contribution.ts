/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { ESQL_RESPONSE_FORMAT_FEATURE_FLAG } from '../../common/feature_flags';
import { createAlertEventStepServices } from '../lib/workflow_extensions/create_alert_event_step_services';
import { registerAlertingV2WorkflowSteps } from '../lib/workflow_extensions/register_alerting_v2_workflow_steps';
import { DEFAULT_ESQL_RESPONSE_FORMAT } from '../lib/services/query_service/formats';

/**
 * The workflow step and triggers of the plugin, in the task process of the workflow task types.
 * Listed under `taskTypeContributions['workflow-steps']` in `kibana.jsonc`. The step's services are
 * built from the host: the internal Elasticsearch client, the feature flags and the security task
 * plugin's privilege checks.
 */
export const contribution: WorkflowStepsContribution = {
  declares: {
    featureFlags: { [ESQL_RESPONSE_FORMAT_FEATURE_FLAG]: DEFAULT_ESQL_RESPONSE_FORMAT.name },
  },
  register: (registry, { host, logger }) => {
    const { elasticsearch, featureFlags, plugins } = host as TaskHost;
    const security = plugins?.security as Pick<SecurityPluginStart, 'authz'> | undefined;
    if (!featureFlags) throw new Error('The workflows task module did not get feature flags');
    if (!security) throw new Error('The task process did not get the security plugin');

    registerAlertingV2WorkflowSteps(
      registry,
      createAlertEventStepServices({
        esClient: elasticsearch.asInternalUser,
        logger: logger.get('alertingVTwo'),
        featureFlags,
        security,
      })
    );
  },
};
