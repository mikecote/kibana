/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggerMock } from '@kbn/logging-mocks';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import {
  ATTACK_DISCOVERY_ATTACHMENT_TYPE,
  ATTACK_DISCOVERY_VERDICT_ATTACHMENT_TYPE,
  DIAGNOSTIC_REPORT_ATTACHMENT_TYPE,
} from '../../common/constants';
import { contribution } from './agent_builder_contribution';
import { getDiscoveriesTaskProcessSettings } from './discoveries_task_process_settings';

const logger = loggerMock.create();
const collect = (agentBuilder?: { attachmentTypeIds: string[]; skillIds: string[] }) =>
  collectRegisteredIds({
    contributions: [contribution],
    settings: {
      discoveries: getDiscoveriesTaskProcessSettings({ connectorTimeout: 60_000, agentBuilder }),
    },
    logger,
  });

describe('Discovery Agent Builder contribution', () => {
  it('registers the actual attachment and skill snapshot without opening execution services', async () => {
    const baseline = await collect();
    const attachmentTypeIds = [
      ATTACK_DISCOVERY_ATTACHMENT_TYPE,
      ATTACK_DISCOVERY_VERDICT_ATTACHMENT_TYPE,
      DIAGNOSTIC_REPORT_ATTACHMENT_TYPE,
    ];
    const skillIds = [
      'attack-discovery-alert-retrieval-builder',
      'attack-discovery-generator',
      'attack-discovery-workflow-troubleshooting',
    ];
    const actual = await collect({ attachmentTypeIds, skillIds });
    expect(actual.attachmentTypes).toEqual(
      [...baseline.attachmentTypes, ...attachmentTypeIds].sort()
    );
    expect(actual.skills).toEqual([...baseline.skills, ...skillIds].sort());
  });

  it('preserves the flag-off registration set independently of the current feature flag', async () => {
    const baseline = await collect();
    const actual = await collect({
      attachmentTypeIds: [ATTACK_DISCOVERY_ATTACHMENT_TYPE],
      skillIds: [],
    });
    expect(actual).toEqual({
      ...baseline,
      attachmentTypes: [...baseline.attachmentTypes, ATTACK_DISCOVERY_ATTACHMENT_TYPE].sort(),
    });
  });

  it('leaves a plugin without successful registrations empty', async () => {
    expect(await collect({ attachmentTypeIds: [], skillIds: [] })).toEqual(await collect());
  });
});
