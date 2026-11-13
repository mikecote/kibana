/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { EntityStoreClientServices } from '../../../create_entity_store_client_services';

export const contribution: WorkflowStepsContribution = {
  declares: { schedulableTypes: [/^entity-test:/] },
  register: (registry, { host: taskHost, services }) => {
    const host = taskHost as TaskHost;
    if (!services) throw new Error('Native entity clients require execution services');
    registry.registerStepDefinition(
      createServerStepDefinition({
        id: 'test.sdk.entity_clients',
        label: 'Use native entity clients',
        description: 'Resolve entities, read relationships and persist native rule settings',
        category: StepCategory.Kibana,
        inputSchema: z.object({ enabled: z.boolean() }),
        outputSchema: z.object({
          enabled: z.boolean(),
          aliases: z.number(),
          relationships: z.number(),
          maintainers: z.array(z.string()),
        }),
        handler: async (context) => {
          const request = context.contextManager.getFakeRequest();
          const namespace = services
            .getService<SpacesPluginStart>('spaces')
            .spacesService.getSpaceId(request);
          const clients = services.getService<EntityStoreClientServices>('entityStore');
          const es = host.elasticsearch.asScoped(request).asCurrentUser;
          const rules = clients.createResolutionRulesClient(
            host.savedObjects.getScopedClient(request),
            namespace
          );
          await rules.setEnabled('email_exact_match', context.input.enabled);
          const enabled = await rules.isEnabled('email_exact_match');
          const resolution = clients.createResolutionClient(es, namespace);
          await resolution.linkEntities('host:target', ['host:alias'], { awaitVisibility: true });
          const group = await resolution.getResolutionGroup('host:target');
          const relationships = await clients
            .createRelationshipsClient(es, namespace)
            .listRelationshipMetadata({ entityId: 'host:target', kind: 'owns' });
          const maintainers = await clients.getMaintainerStatus(namespace);
          return {
            output: {
              enabled,
              aliases: group.aliases.length,
              relationships: relationships.total,
              maintainers: maintainers.map(
                ({ id, taskStatus, lastSuccessTimestamp }) =>
                  `${id}:${taskStatus}:${lastSuccessTimestamp}`
              ),
            },
          };
        },
      })
    );
  },
};
