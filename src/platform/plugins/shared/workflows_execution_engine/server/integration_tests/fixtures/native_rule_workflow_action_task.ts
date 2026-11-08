/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { RuleType, RuleTypeState } from '@kbn/alerting-plugin/server';
import { createRuleTaskType } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { schema } from '@kbn/config-schema';
import type { TypeOf } from '@kbn/config-schema';
import { ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID } from '@kbn/elastic-assistant-common';

const paramsSchema = schema.object({
  workflowId: schema.string({ maxLength: 200 }),
  summaryMode: schema.boolean({ defaultValue: true }),
  inline: schema.boolean({ defaultValue: false }),
});
type Params = TypeOf<typeof paramsSchema>;
interface State extends RuleTypeState {
  status: string;
}

// TaskRunner exposes the native actions client to this rule type for inline connector execution.
const rule: RuleType<Params, Params, State, {}, {}, 'default', 'recovered'> = {
  id: ATTACK_DISCOVERY_SCHEDULES_ALERT_TYPE_ID,
  name: 'Native workflow action proof',
  actionGroups: [{ id: 'default', name: 'Default' }],
  defaultActionGroupId: 'default',
  recoveryActionGroup: { id: 'recovered', name: 'Recovered' },
  minimumLicenseRequired: 'gold',
  isExportable: false,
  category: 'test',
  producer: 'alerts',
  solution: 'security',
  validate: { params: paramsSchema },
  executor: async ({ services, params, spaceId }) => {
    services.alertFactory.create('native-rule-alert').scheduleActions('default', {});
    if (!services.actionsClient) throw new Error('Native rule actions client is missing');
    const result = await services.actionsClient.execute({
      actionId: params.inline
        ? 'system-connector-.test-native-workflow-run'
        : 'system-connector-.workflows',
      params: params.inline
        ? { workflowId: params.workflowId, spaceId }
        : {
            subAction: 'run',
            subActionParams: {
              workflowId: params.workflowId,
              spaceId,
              summaryMode: params.summaryMode,
              inputs: { event: { alerts: [{ _id: 'native-rule-alert', _index: 'alerts' }] } },
            },
          },
    });
    if (result.status !== 'ok') throw new Error(`Workflow connector failed: ${result.message}`);
    return { state: { status: result.status } };
  },
};

export const taskType = createRuleTaskType(
  { ruleTypeId: rule.id, getRuleType: () => rule },
  { executeConnectors: true }
);
