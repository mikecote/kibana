/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { DEFAULT_APP_CATEGORIES } from '@kbn/core/server';
import { KibanaFeature } from '@kbn/features-plugin/common';
import { createGetAlertIndicesAliasFn } from '../lib/create_get_alert_indices_alias';
import {
  createAlertingAuthorizationRegistry,
  getAlertingAuthorizationTaskProcessSettings,
} from './alerting_authorization_task_process_settings';
import type { AlertingAuthorizationRuleTypeSnapshot } from './alerting_authorization_task_process_settings';

it('captures the current native catalog and restores space-aware aliases without sharing mutable metadata', () => {
  const descriptors = new Map<string, AlertingAuthorizationRuleTypeSnapshot>([
    ['rule-one', { id: 'rule-one', alerts: { context: 'observability.test', isSpaceAware: true } }],
  ]);
  const feature = new KibanaFeature({
    id: 'observability',
    name: 'Observability',
    category: DEFAULT_APP_CATEGORIES.observability,
    app: [],
    alerting: [{ ruleTypeId: 'rule-one', consumers: ['apm'] }],
    privileges: {
      all: { savedObject: { all: [], read: [] }, ui: [] },
      read: { savedObject: { all: [], read: [] }, ui: [] },
    },
  });
  const settings = () =>
    getAlertingAuthorizationTaskProcessSettings({
      ruleTypeRegistry: { list: () => descriptors },
      features: { getKibanaFeatures: () => [feature] },
      spacesEnabled: true,
      securityEnabled: true,
    });
  const initial = settings();
  const registry = createAlertingAuthorizationRegistry(initial);
  const getAliases = createGetAlertIndicesAliasFn(registry);
  expect(getAliases(['rule-one'], 'operations')).toEqual([
    '.alerts-observability.test.alerts-operations',
  ]);
  expect(registry.getAllTypes()).toEqual(['rule-one']);
  expect([...registry.list().keys()]).toEqual(['rule-one']);
  expect(initial.features[0].alerting).toEqual([{ ruleTypeId: 'rule-one', consumers: ['apm'] }]);

  descriptors.set('rule-two', {
    id: 'rule-two',
    alerts: { context: 'observability.other', isSpaceAware: false },
  });
  const first = descriptors.get('rule-one');
  if (!first?.alerts) throw new Error('The initial rule descriptor is missing');
  first.alerts.context = 'observability.replaced';
  expect(registry.has('rule-two')).toBe(false);
  expect(getAliases(['rule-one'], 'engineering')).toEqual([
    '.alerts-observability.test.alerts-engineering',
  ]);
  const current = createAlertingAuthorizationRegistry(settings());
  expect(current.getAllTypes()).toEqual(['rule-one', 'rule-two']);
  expect(createGetAlertIndicesAliasFn(current)(['rule-two'], 'engineering')).toEqual([
    '.alerts-observability.other.alerts-default',
  ]);
  expect(() => current.get('missing')).toThrow('Rule type "missing" is not registered.');
});
