/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock, httpServerMock } from '@kbn/core/server/mocks';
import {
  createWorkflowsClientMock,
  workflowsExtensionsMock,
} from '@kbn/workflows-extensions/server/mocks';
import { AlertStatusChangedTriggerId } from '../../../common/workflows/triggers';
import type { AlertStatusChangedV1Payload } from '../../../common/workflows/triggers';
import { AsyncDomainEventBus } from '../events/event_bus';
import type { AlertingDomainEvent, AlertingPublisherContext } from './events';
import { AlertStatusChangedWorkflowSubscriber } from './alert_status_changed_subscriber';
import {
  buildAlertStatusChangedEvents,
  createBusAlertStatusChangedEmitter,
  createWorkflowsAlertStatusChangedEmitter,
  snapshotNewAlertActionGroups,
} from './alert_status_changed_emitter';

const alert = (
  id: string,
  {
    scheduled,
    lastScheduled,
  }: { scheduled?: { actionGroup: string }; lastScheduled?: { group: string } } = {}
) => ({
  getId: () => id,
  getUuid: () => `uuid-${id}`,
  getStart: () => '2026-09-30T00:00:00.000Z',
  getScheduledActionOptions: () => scheduled,
  getLastScheduledActions: () => lastScheduled,
});

const rule: AlertStatusChangedV1Payload['rule'] = {
  id: 'rule-1',
  name: 'Test Rule',
  spaceId: 'default',
  consumer: 'alerts',
  ruleTypeId: '.esql',
  tags: ['k8s'],
  ruleTypeName: 'Elasticsearch query',
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const flushBus = async () => {
  await nextTurn();
  await nextTurn();
};

describe('alert status changed batch', () => {
  it('snapshots the action group of the new alerts that have one', () => {
    const groups = snapshotNewAlertActionGroups({
      a: alert('a', { scheduled: { actionGroup: 'default' } }),
      b: alert('b'),
    });
    expect([...groups]).toEqual([['a', 'default']]);
  });

  it('builds an active event per new alert and a recovered one per recovered alert', () => {
    const events = buildAlertStatusChangedEvents({
      rule,
      newAlerts: { a: alert('a') },
      recoveredAlerts: { c: alert('c', { lastScheduled: { group: 'warning' } }) },
      newAlertActionGroups: new Map([['a', 'default']]),
    });
    expect(events).toEqual([
      {
        rule,
        alert: {
          id: 'a',
          uuid: 'uuid-a',
          status: 'active',
          actionGroup: 'default',
          start: '2026-09-30T00:00:00.000Z',
        },
      },
      {
        rule,
        alert: {
          id: 'c',
          uuid: 'uuid-c',
          status: 'recovered',
          actionGroup: 'warning',
          start: '2026-09-30T00:00:00.000Z',
        },
      },
    ]);
  });

  it('reports no action group for an alert that has none', () => {
    const [event] = buildAlertStatusChangedEvents({
      rule,
      newAlerts: { a: alert('a') },
      recoveredAlerts: {},
      newAlertActionGroups: new Map(),
    });
    expect(event.alert.actionGroup).toBeNull();
  });
});

describe('the emitters of Kibana and of a task process', () => {
  const events = buildAlertStatusChangedEvents({
    rule,
    newAlerts: { a: alert('a', { scheduled: { actionGroup: 'default' } }), b: alert('b') },
    recoveredAlerts: { c: alert('c', { lastScheduled: { group: 'default' } }) },
    newAlertActionGroups: new Map([['a', 'default']]),
  });

  const fakeWorkflows = () => {
    const emitEvent = jest.fn().mockResolvedValue(undefined);
    const getClient = jest
      .fn()
      .mockResolvedValue(createWorkflowsClientMock({ isWorkflowsAvailable: true, emitEvent }));
    return { getClient, emitEvent };
  };

  it('send the same payloads, built from the same request, as the subscriber of the bus', async () => {
    const logger = loggingSystemMock.createLogger();
    const request = httpServerMock.createKibanaRequest();

    // Kibana: the emitter publishes on the bus, the subscriber forwards to the workflows client.
    const kibana = fakeWorkflows();
    const bus = new AsyncDomainEventBus<AlertingDomainEvent, AlertingPublisherContext>(logger);
    const workflows = workflowsExtensionsMock.createStart();
    workflows.getClient.mockImplementation(kibana.getClient);
    const subscriber = new AlertStatusChangedWorkflowSubscriber(bus, workflows, logger);
    subscriber.start();
    createBusAlertStatusChangedEmitter({ bus, optIns: [], logger }).emit({ events, request });
    await flushBus();

    // A task process: the emitter sends with the workflows client the contribution provides.
    const process = fakeWorkflows();
    await createWorkflowsAlertStatusChangedEmitter({
      getClient: process.getClient,
      optIns: [],
      logger,
    }).emit({ events, request });

    expect(process.emitEvent.mock.calls).toEqual(kibana.emitEvent.mock.calls);
    expect(process.emitEvent.mock.calls).toEqual(
      events.map((payload) => [AlertStatusChangedTriggerId, payload])
    );
    // The client is built from the request of the run, which carries the chain context.
    expect(process.getClient.mock.calls.every(([r]) => r === request)).toBe(true);
    expect(kibana.getClient.mock.calls.every(([r]) => r === request)).toBe(true);
    expect(process.getClient).toHaveBeenCalledTimes(events.length);
    expect(kibana.getClient).toHaveBeenCalledTimes(events.length);
    subscriber.stop();
  });

  it('send nothing, and do not throw, when workflows are not available or fail', async () => {
    const logger = loggingSystemMock.createLogger();
    const request = httpServerMock.createKibanaRequest();
    const emitEvent = jest.fn();
    const unavailable = createWorkflowsAlertStatusChangedEmitter({
      getClient: async () => createWorkflowsClientMock({ isWorkflowsAvailable: false, emitEvent }),
      optIns: [],
      logger,
    });
    await unavailable.emit({ events, request });
    expect(emitEvent).not.toHaveBeenCalled();

    const failing = createWorkflowsAlertStatusChangedEmitter({
      getClient: async () => {
        throw new Error('client unavailable');
      },
      optIns: [],
      logger,
    });
    await expect(failing.emit({ events, request })).resolves.toBeUndefined();
    expect(loggingSystemMock.collect(logger).warn).toHaveLength(events.length);
  });

  it('read the opt-ins when asked, so opt-ins registered later apply', async () => {
    const optIns: Array<{ isEnabled: jest.Mock }> = [];
    const emitter = createWorkflowsAlertStatusChangedEmitter({
      getClient: jest.fn(),
      optIns,
      logger: loggingSystemMock.createLogger(),
    });
    const request = httpServerMock.createKibanaRequest();
    expect(emitter.hasOptIns()).toBe(false);
    optIns.push({ isEnabled: jest.fn().mockResolvedValue(false) });
    optIns.push({ isEnabled: jest.fn().mockResolvedValue(true) });
    expect(emitter.hasOptIns()).toBe(true);
    await expect(emitter.isEnabled(request)).resolves.toBe(true);
  });
});
