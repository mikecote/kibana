/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from '@kbn/zod/v4';
import { ALERT_EVENTS_DATA_STREAM } from '@kbn/alerting-v2-constants';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { alertEpisodeSchema } from '@kbn/alerting-v2-schemas';
import type { AlertingServerStart } from '../../../types';
import { EpisodesClient } from '../../../lib/episodes_client';
import { PrivilegeChecker } from '../../../lib/services/privilege_checker/privilege_checker';
import type { AlertingV2RunServices } from '../../create_alerting_v2_run_services';

export const contribution: WorkflowStepsContribution = {
  register: (registry, { services, host }) => {
    if (!services) throw new Error('Alerting client fixture requires execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.alerting_v2.inspect_episode',
        label: 'Read an alert episode',
        description: 'Exercise the scoped episode query and privilege checker',
        category: StepCategory.Kibana,
        inputSchema: z.object({ id: z.string().max(256) }),
        outputSchema: z.object({ episode: alertEpisodeSchema, authorized: z.boolean() }),
        handler: async (context) => {
          const runtime = services.getService<AlertingV2RunServices>('alertingV2.runtime');
          const request = context.contextManager.getFakeRequest();
          const episode = await runtime.resolve(request, EpisodesClient).get(context.input.id);
          if (!episode) throw new Error('The created alert has no episode');
          const authorized = await runtime.resolve(request, PrivilegeChecker).canRead('alerts');
          return { output: { episode, authorized } };
        },
      })
    );
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.alerting_v2.create',
        label: 'Create universal alerting resources',
        description: 'Exercise the shared rule and action policy clients',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({ ruleId: z.string(), policyId: z.string(), episodeId: z.string() }),
        handler: async (context) => {
          const alerting = services.getService<AlertingServerStart>('alertingVTwo');
          const request = context.contextManager.getFakeRequest();
          const rules = await alerting.getRulesClientWithRequest(request);
          const rule = await rules.createRule({
            data: {
              kind: 'alert',
              metadata: { name: 'Persisted universal rule' },
              time_field: '@timestamp',
              schedule: { every: '1m', lookback: '5m' },
              query: { base: 'FROM parity-v2-metrics | WHERE value > 0' },
              recovery: { strategy: 'manual' },
              no_data: { strategy: 'ignore' },
            },
            options: { enabled: false },
          });
          const policies = await alerting.getActionPolicyClientWithRequest(request);
          const policy = await policies.createActionPolicy({
            data: {
              name: 'Policy created in a worker',
              destinations: [{ type: 'workflow', id: 'on-rule-created' }],
            },
          });
          const runtime = services.getService<AlertingV2RunServices>('alertingV2.runtime');
          await runtime.ready();
          const episodeId = randomUUID();
          const timestamp = new Date().toISOString();
          await (host as TaskHost).elasticsearch.asInternalUser.index(
            {
              index: ALERT_EVENTS_DATA_STREAM,
              op_type: 'create',
              refresh: 'wait_for',
              document: {
                '@timestamp': timestamp,
                scheduled_timestamp: timestamp,
                type: 'alert',
                source: 'internal',
                status: 'breached',
                severity: 'high',
                rule: { id: rule.id, version: rule.version },
                alert: { id: episodeId, status: 'active' },
                group_hash: createHash('sha256').update(rule.id).digest('hex'),
                space_id: request.spaceId ?? 'default',
                data: { rule_name: rule.metadata.name },
              },
            },
            { signal: context.abortSignal }
          );
          return { output: { ruleId: rule.id, policyId: policy.id, episodeId } };
        },
      })
    );
  },
};
