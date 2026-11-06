/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';
import { AlertStatusChangedTriggerId } from '../../../common/workflows/triggers';
import type { AlertStatusChangedV1Payload } from '../../../common/workflows/triggers';
import type { EventBus } from '../events/event_bus';
import type { AlertingDomainEvent, AlertingPublisherContext } from './events';
import { ALERT_STATUS_CHANGED_EVENT_TYPE } from './events';
import type { AlertStatusChangedOptIn } from './alert_status_changed_opt_in';
import { isAlertStatusChangedEnabled } from './alert_status_changed_opt_in';

/** What a run publishes after its results are processed. */
export interface AlertStatusChangedBatch {
  events: AlertStatusChangedV1Payload[];
  request: KibanaRequest;
}

/**
 * Where a rule run sends its `alert.status.changed` events. In Kibana it is the in-process bus the
 * workflow subscriber listens to; in a task process it is the workflows client, built from the
 * request of the run, which the workflows plugins contribute to rule runs.
 */
export interface AlertStatusChangedEmitter {
  /** Whether anything opted in; without it a run builds nothing (opt-ins can register later). */
  hasOptIns(): boolean;
  /** Whether events are wanted for the run of this request, asked once there is something to send. */
  isEnabled(request: KibanaRequest): Promise<boolean>;
  /** Sends the events. A task process finishes before the run answers, so it waits for it. */
  emit(batch: AlertStatusChangedBatch): void | Promise<void>;
}

/** The part of a workflows client that carries the events. */
export type AlertStatusChangedWorkflowsClient = Pick<
  Awaited<ReturnType<WorkflowsExtensionsServerPluginStart['getClient']>>,
  'isWorkflowsAvailable' | 'emitEvent'
>;

export type GetAlertStatusChangedWorkflowsClient = (
  request: KibanaRequest
) => Promise<AlertStatusChangedWorkflowsClient>;

interface BatchableAlert {
  getId(): string;
  getUuid(): string;
  getStart(): string | null;
  getScheduledActionOptions(): { actionGroup: string } | undefined;
  getLastScheduledActions(): { group: string } | undefined;
}

/**
 * The action group of each new alert (id -> group). The action scheduler clears the scheduled action
 * options of an alert once it schedules an action for it, so the snapshot is taken before it runs.
 */
export const snapshotNewAlertActionGroups = (
  newAlerts: Record<string, Pick<BatchableAlert, 'getScheduledActionOptions'>>
): Map<string, string> => {
  const actionGroups = new Map<string, string>();
  for (const [id, alert] of Object.entries(newAlerts)) {
    const actionGroup = alert.getScheduledActionOptions()?.actionGroup;
    if (actionGroup != null) {
      actionGroups.set(id, actionGroup);
    }
  }
  return actionGroups;
};

/**
 * The events of a run: one per new alert (active) and one per recovered alert. Kibana and a task
 * process build them with this function, so the payload is the same wherever the rule runs.
 */
export const buildAlertStatusChangedEvents = ({
  rule,
  newAlerts,
  recoveredAlerts,
  newAlertActionGroups,
}: {
  rule: AlertStatusChangedV1Payload['rule'];
  newAlerts: Record<string, BatchableAlert>;
  recoveredAlerts: Record<string, BatchableAlert>;
  newAlertActionGroups: Map<string, string>;
}): AlertStatusChangedV1Payload[] => [
  ...Object.entries(newAlerts).map(([id, alert]) => ({
    rule,
    alert: {
      id: alert.getId(),
      uuid: alert.getUuid(),
      status: 'active' as const,
      actionGroup: newAlertActionGroups.get(id) ?? null,
      start: alert.getStart(),
    },
  })),
  ...Object.values(recoveredAlerts).map((alert) => ({
    rule,
    alert: {
      id: alert.getId(),
      uuid: alert.getUuid(),
      status: 'recovered' as const,
      actionGroup: alert.getLastScheduledActions()?.group ?? null,
      start: alert.getStart(),
    },
  })),
];

/**
 * Sends one event with the workflows client of the request: the one place that does, so the
 * subscriber of Kibana's bus and a task process emit identically. A failure is a warning, never an
 * error and never thrown, so an unavailable workflows service does not fail a run.
 */
export const emitAlertStatusChangedEvent = async ({
  getClient,
  payload,
  request,
  logger,
}: {
  getClient: GetAlertStatusChangedWorkflowsClient;
  payload: AlertStatusChangedV1Payload;
  request: KibanaRequest;
  logger: Logger;
}): Promise<void> => {
  try {
    const client = await getClient(request);
    if (!client.isWorkflowsAvailable) return;
    await client.emitEvent(AlertStatusChangedTriggerId, payload);
  } catch (err) {
    // One line is logged per failed alert for now. A batched emit will make this one line per
    // run.
    logger.warn(
      `[alert_status_changed_subscriber] Failed to emit for rule ${payload.rule.id} alert ${
        payload.alert.uuid
      }: ${err instanceof Error ? err.message : String(err)}`,
      { error: { stack_trace: err instanceof Error ? err.stack : undefined } }
    );
  }
};

/**
 * Kibana: publishes on the in-process bus, which the workflow subscriber forwards. The opt-ins are
 * read when asked, because plugins can register them after the runtime is created.
 */
export const createBusAlertStatusChangedEmitter = ({
  bus,
  optIns,
  logger,
}: {
  bus: EventBus<AlertingDomainEvent, AlertingPublisherContext>;
  optIns: readonly AlertStatusChangedOptIn[];
  logger: Logger;
}): AlertStatusChangedEmitter => ({
  hasOptIns: () => optIns.length > 0,
  isEnabled: (request) => isAlertStatusChangedEnabled({ optIns, request, logger }),
  emit: ({ events, request }) => {
    for (const payload of events) {
      bus.publish({ type: ALERT_STATUS_CHANGED_EVENT_TYPE, payload }, { request });
    }
  },
});

/**
 * A task process: sends each event with the workflows client built from the request of the run
 * (`getClient`), as the subscriber does with the client of the workflows plugin.
 */
export const createWorkflowsAlertStatusChangedEmitter = ({
  getClient,
  optIns,
  logger,
}: {
  getClient: GetAlertStatusChangedWorkflowsClient;
  optIns: readonly AlertStatusChangedOptIn[];
  logger: Logger;
}): AlertStatusChangedEmitter => ({
  hasOptIns: () => optIns.length > 0,
  isEnabled: (request) => isAlertStatusChangedEnabled({ optIns, request, logger }),
  emit: async ({ events, request }) => {
    await Promise.all(
      events.map((payload) => emitAlertStatusChangedEvent({ getClient, payload, request, logger }))
    );
  },
});
