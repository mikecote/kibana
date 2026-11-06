/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';
import type { AsyncDomainEventBus } from '../events/event_bus';
import type {
  AlertStatusChangedEvent,
  AlertingDomainEvent,
  AlertingPublisherContext,
} from './events';
import { ALERT_STATUS_CHANGED_EVENT_TYPE } from './events';
import type { Subscription } from '../events/event_bus/types';
import { emitAlertStatusChangedEvent } from './alert_status_changed_emitter';

/**
 * Attaches to the in-process alerting bus and forwards
 * `alert.status.changed` events to the workflows-extensions emit path.
 */
export class AlertStatusChangedWorkflowSubscriber {
  #subscription: Subscription | null = null;

  constructor(
    private readonly bus: AsyncDomainEventBus<AlertingDomainEvent, AlertingPublisherContext>,
    private readonly workflows: WorkflowsExtensionsServerPluginStart,
    private readonly logger: Logger
  ) {}

  public start(): void {
    if (this.#subscription !== null) {
      this.logger.debug('[alert_status_changed_subscriber] start called more than once; ignoring');
      return;
    }

    this.#subscription = this.bus.subscribe(
      ALERT_STATUS_CHANGED_EVENT_TYPE,
      (event: AlertStatusChangedEvent, context: AlertingPublisherContext) =>
        this.#emit(event, context)
    );
  }

  public stop(): void {
    this.#subscription?.unsubscribe();
    this.#subscription = null;
  }

  async #emit(event: AlertStatusChangedEvent, context: AlertingPublisherContext): Promise<void> {
    await emitAlertStatusChangedEvent({
      getClient: (request) => this.workflows.getClient(request),
      payload: event.payload,
      request: context.request,
      logger: this.logger,
    });
  }
}
