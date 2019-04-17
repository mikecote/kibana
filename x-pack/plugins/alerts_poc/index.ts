/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { AlertService } from './alert_service';
import { ActionService } from './action_service';

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [alerts-poc] ${message}`, ...args);

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
    defaultActionParams: {
      subject: '[warning] High CPU usage',
      body: 'The CPU usage is a little high: {cpuUsage}%',
      message: 'The CPU usage is a little high: {cpuUsage}%',
    },
    async execute({ fire }, { warningThreshold, severeThreshold }, state) {
      const cpuUsage = Math.floor(Math.random() * 100);

      if (cpuUsage > severeThreshold) {
        log(`[alert][execute] Previous CPU usage: ${state.cpuUsage}`);
        fire('severe', { cpuUsage });
      } else if (cpuUsage > warningThreshold) {
        log(`[alert][execute] Previous CPU usage: ${state.cpuUsage}`);
        fire('warning', { cpuUsage });
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
    log(`[action] [connector] Sending smtp email...`);
  });
  actionService.registerConnector('slack', async (connectorOptions: any, params: any) => {
    log(`[action] [connector] Sending slack message...`);
  });
  actionService.registerConnector('console', async (connectorOptions: any, params: any) => {
    log(params.message);
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
    id: 'cpu-check',
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

function toggleAlert(alertService: AlertService) {
  setTimeout(() => {
    alertService.disable('cpu-check');

    setTimeout(() => {
      alertService.enable('cpu-check');
    }, 1000);
  }, 1000);
}
