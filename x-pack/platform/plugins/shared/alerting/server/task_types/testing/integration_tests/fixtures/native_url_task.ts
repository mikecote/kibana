/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { TypeOf } from '@kbn/config-schema';
import type { LocatorDefinition } from '@kbn/share-plugin/common/url_service';
import type { SerializableRecord } from '@kbn/utility-types';
import type { RuleType, RuleTypeState } from '../../../../types';
import { createRuleTaskType } from '../../../rule_task_type';

interface NativeUrlParams extends SerializableRecord {
  dashboardId: string;
}
const locator: LocatorDefinition<NativeUrlParams> = {
  id: 'NATIVE_RULE_URL',
  getLocation: async ({ dashboardId }) => ({
    app: 'dashboards',
    path: `/view/${dashboardId}`,
    state: {},
  }),
  extract: (state) => ({
    state: { dashboardId: '' },
    references: [{ name: 'dashboard', type: 'dashboard', id: state.dashboardId }],
  }),
  inject: (state, references) => {
    const dashboard = references.find(({ name }) => name === 'dashboard');
    if (!dashboard) throw new Error('Native URL lost its dashboard reference');
    return { dashboardId: dashboard.id };
  },
};

const paramsSchema = schema.object({
  sourceId: schema.maybe(schema.string({ maxLength: 200 })),
  remove: schema.boolean({ defaultValue: false }),
});
type Params = TypeOf<typeof paramsSchema>;
interface State extends RuleTypeState {
  id: string;
  slug: string;
  dashboardId: string;
  removed: boolean;
  completedRuns: number;
}
type NativeRuleType = RuleType<Params, Params, State, {}, {}, 'default', 'recovered'>;
const nativeRule: NativeRuleType = {
  id: 'test.native-url',
  name: 'Native rule URL proof',
  actionGroups: [{ id: 'default', name: 'Default' }],
  defaultActionGroupId: 'default',
  recoveryActionGroup: { id: 'recovered', name: 'Recovered' },
  minimumLicenseRequired: 'basic',
  isExportable: false,
  category: 'test',
  producer: 'alerts',
  solution: 'stack',
  validate: { params: paramsSchema },
  executor: async ({ services, params }) => {
    const nativeLocator = services.share.url.locators.get<NativeUrlParams>(locator.id);
    if (!nativeLocator) throw new Error('Native rule locator is missing');
    const client = services.share.url.shortUrls.get({
      savedObjects: services.savedObjectsClient,
    });
    const short = params.sourceId
      ? await client.get(params.sourceId)
      : await client.create({
          locator: nativeLocator,
          params: { dashboardId: 'native-dashboard' },
        });
    const resolved = await client.resolve(short.data.slug);
    if (resolved.data.id !== short.data.id)
      throw new Error('Native short URL did not resolve to its stored ID');
    if (params.remove) await client.delete(short.data.id);
    const { dashboardId } = resolved.data.locator.state;
    if (typeof dashboardId !== 'string')
      throw new Error('Native locator did not inject its dashboard ID');
    return {
      state: {
        id: short.data.id,
        slug: short.data.slug,
        dashboardId,
        removed: params.remove,
        completedRuns: 0,
      },
    };
  },
};

export const taskType = createRuleTaskType(
  {
    ruleTypeId: nativeRule.id,
    getRuleType: ({ host }): NativeRuleType => {
      let completedRuns = 0;
      return {
        ...nativeRule,
        executor: async (options) => {
          if (!host.onRunEnd) throw new Error('Native rule needs run completion tracking');
          host.onRunEnd(async () => {
            completedRuns++;
          });
          const result = await nativeRule.executor(options);
          return {
            ...result,
            state: { ...result.state, completedRuns },
          };
        },
      };
    },
  },
  { locators: [locator] }
);
