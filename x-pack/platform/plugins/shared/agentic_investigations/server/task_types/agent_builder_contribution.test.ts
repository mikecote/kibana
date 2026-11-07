/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import {
  ESCALATION_ATTACHMENTS_SYNCED_EVENT_TYPE,
  ESCALATION_CREATED_FROM_INVESTIGATION_EVENT_TYPE,
  ESCALATION_INVESTIGATION_LINKED_EVENT_TYPE,
} from '../../common/escalations/conversation_events';
import { contribution } from './agent_builder_contribution';
import {
  AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID,
  type AgenticInvestigationsTaskProcessSettings,
} from './agentic_investigations_task_process_settings';

const record = (settings: Record<string, AgenticInvestigationsTaskProcessSettings>) =>
  collectRegisteredIds({
    contributions: [contribution],
    settings,
    logger: loggingSystemMock.createLogger(),
  });

describe('agentic investigations worker registrations', () => {
  it.each([false, true])(
    'preserves the native registry inventory with escalations enabled: %s',
    async (escalationsEnabled) => {
      const baseline = await record({});
      const registered = await record({
        [AGENTIC_INVESTIGATIONS_TASK_PROCESS_SETTINGS_ID]: {
          escalationsEnabled,
          securityEnabled: true,
          spacesEnabled: true,
          proposalsEnabled: true,
        },
      });
      const added = Object.fromEntries(
        Object.entries(registered).map(([kind, ids]) => [
          kind,
          ids.filter((id) => !baseline[kind as keyof typeof baseline].includes(id)),
        ])
      );
      expect(added).toEqual({
        ...Object.fromEntries(Object.keys(baseline).map((kind) => [kind, []])),
        tools: ['agentic_investigations.set_hypotheses', 'agentic_investigations.set_impact'],
        attachmentTypes: [
          'investigation_hypotheses',
          'investigation_impact',
          'investigation_subject',
        ],
        conversationEvents: escalationsEnabled
          ? [
              ESCALATION_ATTACHMENTS_SYNCED_EVENT_TYPE,
              ESCALATION_CREATED_FROM_INVESTIGATION_EVENT_TYPE,
              ESCALATION_INVESTIGATION_LINKED_EVENT_TYPE,
            ].sort()
          : [],
      });
    }
  );
});
