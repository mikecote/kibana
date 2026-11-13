/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock, httpServerMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { CasesEventBus } from '@kbn/cases-plugin/server/events/event_bus';
import { SecuritySolutionEventBus } from '../events/event_bus';
import { registerSecurityWorkflowEventBridge } from '../workflows/triggers/event_bridge';
import { AlertStatusChangedTriggerId } from '../../common/workflows/triggers';
import { contribution } from './cases_client_contribution';

it('forwards Cases Security alert status changes through the shared native Security workflow bus', async () => {
  const core = coreMock.createStart();
  const logger = loggerMock.create();
  const eventBus = new SecuritySolutionEventBus();
  const emitEvent = jest.fn().mockResolvedValue(undefined);
  const flushEvents = registerSecurityWorkflowEventBridge(
    eventBus,
    { getClient: async () => ({ emitEvent }) },
    logger
  );
  const extension = contribution.create({
    host: core,
    logger,
    settings: {},
    services: { getService: jest.fn().mockReturnValue({ eventBus, flushEvents }) },
  });
  const casesEventBus = new CasesEventBus(logger);
  extension.registerAlertStatusListener?.(casesEventBus);
  const request = httpServerMock.createKibanaRequest();
  casesEventBus.emitAlertStatusChanged(request, {
    alertIds: ['security-alert', 'other-alert', 'unchanged-alert'],
    status: 'closed',
    previousStatuses: [
      { id: 'security-alert', previousStatus: 'open' },
      { id: 'unchanged-alert', previousStatus: 'closed' },
    ],
    alertIdToIndex: {
      'security-alert': '.alerts-security.alerts-default',
      'other-alert': '.alerts-observability.logs-default',
      'unchanged-alert': '.internal.alerts-security.alerts-default-000001',
    },
    indices: ['.alerts-security.alerts-default'],
  });
  await flushEvents();
  expect(emitEvent).toHaveBeenCalledTimes(1);
  expect(emitEvent).toHaveBeenCalledWith(
    AlertStatusChangedTriggerId,
    expect.objectContaining({ alertIds: ['security-alert'], status: 'closed' })
  );
});
