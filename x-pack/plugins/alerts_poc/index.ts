/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { AlertService } from './alert_service';
import { ActionService } from './action_service';

// eslint-disable-next-line no-console
const log = (message: string, ...args: any) => console.log(`[alerts-poc] ${message}`, ...args);

export function alertsPoc(kibana: any) {
  return new kibana.Plugin({
    id: 'alerts_poc',
    require: ['kibana', 'elasticsearch'],
    init() {
      const actionService = getActionService();
      const alertService = getAlertService(actionService);
      scheduleAlerts(alertService);
      toggleAlert(alertService);
    },
  });
}

function getAlertService(actionService: ActionService) {
  const alertService = new AlertService(actionService);
  alertService.register({
    id: 'cpu-check',
    desc: 'Check CPU usage above threshold',
    async execute({ fire }, { threshold }, state) {
      const cpuUsage = Math.floor(Math.random() * 100);

      if (cpuUsage > threshold) {
        log(`[alert][execute] Previous CPU usage: ${state.cpuUsage}`);
        fire({ cpuUsage });
      }

      return {
        cpuUsage,
      };
    },
  });
  return alertService;
}

function getActionService() {
  const actionService = new ActionService();
  actionService.registerConnector('smtp', async (connectorOptions: any, params: any) => {
    log(`[action][connector] Sending smtp email...`);
  });
  actionService.registerConnector('slack', async (connectorOptions: any, params: any) => {
    log(`[action][connector] Sending slack message...`);
  });
  actionService.registerConnector('console', async (connectorOptions: any, params: any) => {
    log(`[action][connector] Logging console message...`);
    log(params.message);
  });
  actionService.createAction({
    id: 'console-log',
    description: 'Send message to the console',
    connector: 'console',
    attributes: {},
  });
  return actionService;
}

function scheduleAlerts(alertService: AlertService) {
  alertService.schedule({
    id: 'cpu-check',
    interval: 10 * 1000, // 10s
    actions: [
      {
        id: 'console-log',
        params: {
          message: `The CPU usage is a little high: {cpuUsage}%`,
        },
      },
    ],
    checkParams: {
      threshold: 10,
    },
  });
}

function toggleAlert(alertService: AlertService) {
  setTimeout(() => {
    alertService.disable('cpu-check');

    setTimeout(() => {
      alertService.enable('cpu-check');
    }, 1000);
  }, 1000);
}
