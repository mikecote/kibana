/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import { collectRegisteredIds } from '@kbn/agent-builder-plugin/server/run_services/collect_registered_ids';
import { ALERTZERO_ACTIONS_LIST_TOOL_ID } from '@kbn/alertzero-common';
import { registerAlertZeroAgentBuilder } from '../agent_builder/register_agent_builder';
import { ALERTZERO_ATTACHMENT_TYPES } from '../../common/constants';
import { contribution } from './agent_builder_contribution';
import { ALERTZERO_AGENT_BUILDER_SETTINGS_ID } from './alertzero_agent_builder_task_process_settings';

it.each([true, false])(
  'registers the native AlertZero surface without resolving execution services (actions available: %s)',
  async (actionsAvailable) => {
    const logger = loggingSystemMock.createLogger();
    const getActionsService = jest.fn();
    const assertAlertZeroAccess = jest.fn();
    const isEnabledForRequest = jest.fn();
    const native: AgentBuilderContribution = {
      register: (agentBuilder) =>
        registerAlertZeroAgentBuilder({
          agentBuilder,
          getActionsService,
          assertAlertZeroAccess,
          isEnabledForRequest,
        }),
    };
    const ids = await collectRegisteredIds({ contributions: [native], settings: {}, logger });
    expect(
      await collectRegisteredIds({
        contributions: [contribution],
        settings: {
          [ALERTZERO_AGENT_BUILDER_SETTINGS_ID]: {
            actionsAvailable,
            managementAvailable: actionsAvailable,
          },
        },
        logger,
      })
    ).toEqual(ids);
    expect(ids.tools).toContain(ALERTZERO_ACTIONS_LIST_TOOL_ID);
    expect(ids.attachmentTypes).toEqual(
      expect.arrayContaining(Object.values(ALERTZERO_ATTACHMENT_TYPES))
    );
    expect(getActionsService).not.toHaveBeenCalled();
    expect(assertAlertZeroAccess).not.toHaveBeenCalled();
    expect(isEnabledForRequest).not.toHaveBeenCalled();
  }
);

it('does not register AlertZero when Kibana did not enable its agent integration', async () => {
  const logger = loggingSystemMock.createLogger();
  expect(
    await collectRegisteredIds({ contributions: [contribution], settings: {}, logger })
  ).toEqual(await collectRegisteredIds({ contributions: [], settings: {}, logger }));
});
