/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import Boom from '@hapi/boom';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { WorkflowRulesReadServices } from '@kbn/alerting-plugin/server/task_types/create_workflow_rules_read_client';
import type { SerializedSearchSourceFields } from '@kbn/data-plugin/common';
import type { EsQueryRuleParams } from '@kbn/response-ops-rule-params/es_query';
import { STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE } from '../../../../common/constants';
import { streamsConfigurationEncryptedType } from '../../../lib/saved_objects/streams_configuration';
import { getRulesByIds, getSuggestedRules } from '../../../lib/streams/attachments/utils';

export const contribution: WorkflowStepsContribution = {
  declares: { encryptedSavedObjectTypes: [streamsConfigurationEncryptedType] },
  register: (registry, { services, host: taskHost }) => {
    const host = taskHost as TaskHost;
    if (!services) throw new Error('Native rule reads require execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.sdk.rules_read',
        label: 'Read native rules',
        description: 'Read real rules and Streams attachments through native authorization',
        category: StepCategory.Kibana,
        inputSchema: z.object({}),
        outputSchema: z.object({
          index: z.string(),
          names: z.array(z.string()),
          url: z.string(),
          attachmentNames: z.array(z.string()),
          suggestions: z.array(z.string()),
          hasApiKey: z.boolean(),
          foreignVisible: z.boolean(),
          canvasSecret: z.string(),
        }),
        handler: async (context) => {
          if (!host.encryptedSavedObjects)
            throw new Error('Streams canvas requires native encryption');
          const configuration = await host.encryptedSavedObjects
            .getClient({
              includedHiddenTypes: [STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE],
            })
            .getDecryptedAsInternalUser<{ secrets: string }>(
              STREAMS_CONFIGURATION_SAVED_OBJECT_TYPE,
              'default'
            );
          const secrets = z
            .object({ token: z.string() })
            .parse(JSON.parse(configuration.attributes.secrets));
          const request = context.contextManager.getFakeRequest();
          const rulesClient = await services
            .getService<WorkflowRulesReadServices>('alerting')
            .getRulesClientWithRequest(request);
          let foreignVisible = false;
          try {
            await rulesClient.get({ id: 'foreign-query-rule' });
            foreignVisible = true;
          } catch (error) {
            if (!Boom.isBoom(error) || error.output.statusCode !== 404) throw error;
          }
          const rule = await rulesClient.get<
            Omit<EsQueryRuleParams, 'searchConfiguration'> & {
              searchConfiguration: SerializedSearchSourceFields;
            }
          >({ id: 'query-rule' });
          const bulk = await rulesClient.bulkGetRules({ ids: ['query-rule', 'threshold-rule'] });
          const found = await rulesClient.find({
            options: { search: 'Native', searchFields: ['name'] },
          });
          const threshold = found.data.find(({ id }) => id === 'threshold-rule');
          const attachments = await getRulesByIds({
            rulesClient,
            ids: ['query-rule', 'threshold-rule'],
          });
          const suggestions = await getSuggestedRules({ rulesClient, query: 'Native', limit: 10 });
          return {
            output: {
              foreignVisible,
              canvasSecret: secrets.token,
              index: String(rule.params.searchConfiguration?.index),
              names: bulk.rules.map(({ name }) => name).sort(),
              url: threshold?.viewInAppRelativeUrl ?? '',
              attachmentNames: attachments.map(({ title }) => title).sort(),
              suggestions: suggestions.map(({ title }) => title).sort(),
              hasApiKey: [rule, ...found.data, ...bulk.rules].some((value) =>
                Object.hasOwn(value, 'apiKey')
              ),
            },
          };
        },
      })
    );
  },
};
