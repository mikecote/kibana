/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { httpServerMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { INVESTIGATION_STARTED_TRIGGER_ID } from '../../../common/workflows/triggers';
import type { InvestigationStartedTriggerPayload } from '../../../common/workflows/triggers';
import { createTriggerEmitter } from './emit';

const payload: InvestigationStartedTriggerPayload = {
  investigation_id: 'native-investigation',
  status: 'running',
  subject: { type: 'alert', id: 'native-alert' },
  trigger_type: 'manual',
  started_at: '2026-11-07T00:00:00.000Z',
};

it('tracks native trigger delivery until the asynchronous emission has completed', async () => {
  const pending: Array<Promise<void>> = [];
  let delivered = false;
  const emitEvent = jest.fn(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    delivered = true;
  });
  const request = httpServerMock.createKibanaRequest();
  const getClient = jest.fn(async () => ({ emitEvent }));
  const emit = createTriggerEmitter({
    request,
    logger: loggerMock.create(),
    workflowsExtensions: { getClient },
    onEmission: (emission) => {
      pending.push(emission);
    },
  });
  emit?.(INVESTIGATION_STARTED_TRIGGER_ID, payload);
  expect(delivered).toBe(false);
  expect(pending).toHaveLength(1);
  await Promise.all(pending);
  expect(delivered).toBe(true);
  expect(getClient).toHaveBeenCalledWith(request);
  expect(emitEvent).toHaveBeenCalledWith(INVESTIGATION_STARTED_TRIGGER_ID, payload);
});

it('completes tracked emissions after reporting native client failures', async () => {
  const pending: Array<Promise<void>> = [];
  const logger = loggerMock.create();
  const emit = createTriggerEmitter({
    request: httpServerMock.createKibanaRequest(),
    logger,
    workflowsExtensions: {
      getClient: jest.fn().mockRejectedValue(new Error('Native workflow client unavailable')),
    },
    onEmission: (emission) => {
      pending.push(emission);
    },
  });
  emit?.(INVESTIGATION_STARTED_TRIGGER_ID, payload);
  await Promise.all(pending);
  expect(logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('Native workflow client unavailable')
  );
});
