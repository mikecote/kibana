/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ECS_COMPONENT_TEMPLATE_NAME } from '@kbn/alerting-plugin/server';
import { mappingFromFieldMap } from '@kbn/alerting-plugin/common';
import type { IndexOptions } from '@kbn/rule-registry-plugin/server';
import { Dataset } from '@kbn/rule-registry-plugin/server';
import { ATTACK_DISCOVERY_SCHEDULES_CONSUMER_ID } from '@kbn/elastic-assistant-common';
import {
  ATTACK_DISCOVERY_ALERTS_CONTEXT,
  attackDiscoveryAlertFieldMap,
} from '@kbn/discoveries/impl/attack_discovery/alert_fields';

export const getAttackDiscoveryIndexOptions = (): IndexOptions => ({
  // IMPORTANT: These values MUST match what elastic_assistant uses to ensure
  // both plugins read/write to the same index. See elastic_assistant/server/plugin.ts
  // The resulting index pattern is: .adhoc.alerts-security.attack.discovery.alerts-{namespace}
  feature: ATTACK_DISCOVERY_SCHEDULES_CONSUMER_ID,
  registrationContext: ATTACK_DISCOVERY_ALERTS_CONTEXT,
  dataset: Dataset.alerts,
  additionalPrefix: '.adhoc',
  componentTemplateRefs: [ECS_COMPONENT_TEMPLATE_NAME],
  componentTemplates: [
    {
      name: 'mappings',
      mappings: mappingFromFieldMap(attackDiscoveryAlertFieldMap),
    },
  ],
});
