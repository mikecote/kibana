/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { AlertService } from './alert_service';
import { ActionService } from './action_service';
import mappings from './mappings.json';
import { SavedObjectsClient } from '../../../src/legacy/server/saved_objects';
import { initRoutes } from './server/routes';

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [alerts-poc] ${message}`, ...args);

export function alertsPoc(kibana: any) {
  return new kibana.Plugin({
    id: 'alerts_poc',
    require: ['kibana', 'elasticsearch', 'task_manager'],
    init(server: any) {
      // Saved objects client
      const { callWithInternalUser } = server.plugins.elasticsearch.getCluster('admin');
      const savedObjectsClient = server.savedObjects.getSavedObjectsRepository(
        callWithInternalUser
      );

      // Task manager
      const { taskManager } = server;

      // Alerting services
      const actionService = getActionService(savedObjectsClient);
      const alertService = getAlertService(actionService, taskManager);

      // TODO: Find event when taskManager is up and running
      setTimeout(() => {
        scheduleAlerts(alertService);
      }, 3000);

      // Routes
      initRoutes(server, alertService);
    },
    uiExports: {
      mappings,
    },
  });
}

function getAlertService(actionService: ActionService, taskManager: any) {
  const alertService = new AlertService(actionService, taskManager);
  alertService.register({
    id: 'fleet-cpu-check',
    desc: 'Check CPU usage above threshold',
    defaultActionParams: {
      subject: '[warning] High CPU usage',
      body: 'The CPU usage is a little high: {cpuUsage}%',
      message: 'The CPU usage is a little high: {cpuUsage}%',
    },
    async execute({ alertInstanceFactory }, { warningThreshold, severeThreshold }) {
      const queryResults = await Promise.resolve([
        { id: '1', cpuUsage: Math.floor(Math.random() * 100) },
        { id: '2', cpuUsage: Math.floor(Math.random() * 100) },
        { id: '3', cpuUsage: Math.floor(Math.random() * 100) },
      ]);

      queryResults.map(({ id, cpuUsage }) => {
        alertInstanceFactory(id, (instance, previousState) => {
          if (cpuUsage > severeThreshold) {
            log(`[alert][execute] Previous CPU usage: ${previousState.cpuUsage}`);
            instance.fire('severe', {}, { cpuUsage });
            instance.replaceState({ cpuUsage });
          } else if (cpuUsage > warningThreshold) {
            log(`[alert][execute] Previous CPU usage: ${previousState.cpuUsage}`);
            instance.fire('warning', {}, { cpuUsage });
            instance.replaceState({ cpuUsage });
          }
        });
      });
    },
  });
  return alertService;
}

function getActionService(savedObjectsClient: SavedObjectsClient) {
  const actionService = new ActionService(savedObjectsClient);
  actionService.registerConnector('smtp', async (connectorOptions: any, params: any) => {
    log(`[action] [connector] Sending smtp email...`);
  });
  actionService.registerConnector('slack', async (connectorOptions: any, params: any) => {
    log(`[action] [connector] Sending slack message...`);
  });
  actionService.registerConnector('console', async (connectorOptions: any, params: any) => {
    log(`[action][connector]`, params.message);
  });
  actionService.registerConnector('light', async (connectorOptions: any, params: any) => {
    log(`[action][connector] Turning on light...`);
  });
  actionService.createAction({
    id: 'console-log',
    description: 'Send message to the console',
    connector: 'console',
    attributes: {},
  });
  actionService.createAction({
    id: 'turn-on-alarm-light',
    description: 'Turn on a physical alarm light',
    connector: 'light',
    attributes: {},
  });
  return actionService;
}

function scheduleAlerts(alertService: AlertService) {
  alertService.schedule({
    id: 'fleet-cpu-check',
    interval: 10 * 1000, // 10s
    throttle: 30 * 1000, // 30s
    actionGroupsPriority: ['severe', 'warning', 'default'],
    actionGroups: {
      // I think these should be called "channels"
      default: [
        {
          id: 'console-log',
          params: {
            message: `The CPU usage is high: {cpuUsage}%`,
          },
        },
      ],
      warning: [
        {
          id: 'console-log',
          params: {
            message: `The CPU usage is a little high: {cpuUsage}%`,
          },
        },
      ],
      severe: [
        {
          id: 'console-log',
          params: {
            message: `The CPU usage is super duper high: {cpuUsage}%`,
          },
        },
        {
          id: 'turn-on-alarm-light',
          params: {},
        },
      ],
    },
    checkParams: {
      severeThreshold: 50,
      warningThreshold: 10,
    },
  });
}
