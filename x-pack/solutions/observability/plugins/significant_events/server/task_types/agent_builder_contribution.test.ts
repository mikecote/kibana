/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { platformSignificantEventsTools } from '@kbn/agent-builder-common';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import {
  SIGNIFICANT_EVENT_ATTACHMENT_TYPE,
  KI_FEATURE_ATTACHMENT_TYPE,
  SIGNIFICANT_EVENT_DETECTION_ATTACHMENT_TYPE,
} from '../../common';
import { SIGNIFICANT_EVENTS_DISCOVERY_AGENT_TYPE_ID } from '../agent_builder/agents/discovery';
import { FEATURE_IDENTIFICATION_AGENT_TYPE_ID } from '../agent_builder/agents/feature_identification';
import { KI_QUERY_GENERATION_AGENT_TYPE_ID } from '../agent_builder/agents/ki_query_generation';
import type { SignificantEventsTaskProcessSettings } from './significant_events_task_process_settings';
import { contribution } from './agent_builder_contribution';

const snapshot: SignificantEventsTaskProcessSettings = {
  cpsEnabled: false,
  availability: {
    deploymentSupported: true,
    pricingTierAvailable: true,
    requiredPlugins: ['agentBuilder', 'workflowsExtensions', 'workflowsManagement'],
  },
  registrations: {
    toolIds: Object.values(platformSignificantEventsTools),
    attachmentTypeIds: [
      SIGNIFICANT_EVENT_ATTACHMENT_TYPE,
      KI_FEATURE_ATTACHMENT_TYPE,
      SIGNIFICANT_EVENT_DETECTION_ATTACHMENT_TYPE,
    ],
    agentTypeIds: [
      SIGNIFICANT_EVENTS_DISCOVERY_AGENT_TYPE_ID,
      FEATURE_IDENTIFICATION_AGENT_TYPE_ID,
      KI_QUERY_GENERATION_AGENT_TYPE_ID,
    ],
    skillIds: [
      'knowledge-indicators-management',
      'ki-query-generation',
      'significant-events-ki-grounding',
      'significant-events-management',
      'feature-identification',
      'ki-identification-management',
      'streams-investigation-management',
    ],
    smlTypeIds: ['significant_event'],
  },
};

const record = (settings: Record<string, SignificantEventsTaskProcessSettings>) =>
  collectRegisteredIds({
    contributions: [contribution],
    settings,
    logger: loggingSystemMock.createLogger(),
  });

describe('significant events worker registrations', () => {
  it('records native setup and start registrations without accessing execution services', async () => {
    const baseline = await record({});
    const registered = await record({ significantEvents: snapshot });
    const added = Object.fromEntries(
      Object.entries(registered).map(([kind, ids]) => [
        kind,
        ids.filter((id) => !baseline[kind as keyof typeof baseline].includes(id)),
      ])
    );
    expect(added).toEqual({
      ...Object.fromEntries(Object.keys(baseline).map((kind) => [kind, []])),
      tools: [...snapshot.registrations.toolIds].sort(),
      attachmentTypes: [...snapshot.registrations.attachmentTypeIds].sort(),
      agentTypes: [...snapshot.registrations.agentTypeIds].sort(),
      skills: [...snapshot.registrations.skillIds].sort(),
      smlTypes: snapshot.registrations.smlTypeIds,
    });
  });

  it('keeps only successful native registrations and accepts later start-time skills', async () => {
    const registrations = {
      ...snapshot.registrations,
      toolIds: [platformSignificantEventsTools.searchEvent],
      attachmentTypeIds: [],
      skillIds: [],
      smlTypeIds: [],
    };
    const early = await record({ significantEvents: { ...snapshot, registrations } });
    const later = await record({
      significantEvents: {
        ...snapshot,
        registrations: { ...registrations, skillIds: ['ki-identification-management'] },
      },
    });
    expect(later).toEqual({
      ...early,
      skills: [...early.skills, 'ki-identification-management'].sort(),
    });
    expect(early.tools.filter((id) => snapshot.registrations.toolIds.includes(id))).toEqual([
      platformSignificantEventsTools.searchEvent,
    ]);
  });
});
