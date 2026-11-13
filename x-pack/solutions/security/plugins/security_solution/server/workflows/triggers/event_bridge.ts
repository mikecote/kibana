/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import { createWorkflowTriggerForwarder } from '@kbn/workflows-extensions/server';
import type { SecuritySolutionEventPayload } from '../../events/types';
import type { SecuritySolutionEventBus } from '../../events/event_bus';
import {
  AlertStatusChangedTriggerId,
  AlertTagsChangedTriggerId,
  AlertAssigneesChangedTriggerId,
  AttackStatusChangedTriggerId,
  AttackTagsChangedTriggerId,
  AttackAssigneesChangedTriggerId,
  NoteCreatedTriggerId,
  NoteUpdatedTriggerId,
} from '../../../common/workflows/triggers';

export const registerSecurityWorkflowEventBridge = (
  eventBus: SecuritySolutionEventBus,
  workflowsExtensions: Parameters<typeof createWorkflowTriggerForwarder>[0] | undefined,
  logger: Pick<Logger, 'warn'>
): (() => Promise<void>) => {
  if (!workflowsExtensions) {
    return () => Promise.resolve();
  }

  const forward = createWorkflowTriggerForwarder(workflowsExtensions, logger);

  const pending = new Set<Promise<void>>();
  const forwardEvent = (
    triggerId: string,
    payload: SecuritySolutionEventPayload['payload'],
    request: KibanaRequest
  ): void => {
    const completion = forward(triggerId, payload, request).catch((error) => {
      logger.warn(`Failed to forward workflow trigger event [${triggerId}]: ${error}`);
    });
    pending.add(completion);
    void completion.then(
      () => pending.delete(completion),
      () => pending.delete(completion)
    );
  };

  eventBus.onAlertStatusChanged((event) => {
    forwardEvent(AlertStatusChangedTriggerId, event.payload, event.request);
  });

  eventBus.onAlertTagsChanged((event) => {
    forwardEvent(AlertTagsChangedTriggerId, event.payload, event.request);
  });

  eventBus.onAlertAssigneesChanged((event) => {
    forwardEvent(AlertAssigneesChangedTriggerId, event.payload, event.request);
  });

  eventBus.onAttackStatusChanged((event) => {
    forwardEvent(AttackStatusChangedTriggerId, event.payload, event.request);
  });

  eventBus.onAttackTagsChanged((event) => {
    forwardEvent(AttackTagsChangedTriggerId, event.payload, event.request);
  });

  eventBus.onAttackAssigneesChanged((event) => {
    forwardEvent(AttackAssigneesChangedTriggerId, event.payload, event.request);
  });

  eventBus.onNoteCreated((event) => {
    forwardEvent(NoteCreatedTriggerId, event.payload, event.request);
  });

  eventBus.onNoteUpdated((event) => {
    forwardEvent(NoteUpdatedTriggerId, event.payload, event.request);
  });
  return async () => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
};
