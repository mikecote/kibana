/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { Scheduler } from './scheduler';
import { ActionService } from './action_service';

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`[alerts-poc][alert-service] ${message}`, ...args);

interface Alert {
  id: string;
  desc: string;
  isMuted: boolean;
  execute: (services: any, checkParams: any, previousState: any) => Promise<Record<string, any>>;
}

interface ScheduledAlert {
  id: string;
  interval: number;
  actions: Array<{
    id: string;
    params: any;
  }>;
  checkParams: any;
}

export class AlertService {
  scheduler: Scheduler;
  actionService: ActionService;
  alerts: { [key: string]: Alert };

  constructor(actionService: ActionService) {
    this.alerts = {};
    this.scheduler = new Scheduler();
    this.actionService = actionService;
  }

  register(alert: Alert) {
    this.alerts[alert.id] = alert;
    log(`Registered ${alert.id}`);
  }

  mute(id: string) {
    this.alerts[id].isMuted = true;
  }

  unmute(id: string) {
    this.alerts[id].isMuted = false;
  }

  schedule({ id, interval, actions, checkParams }: ScheduledAlert) {
    const alert = this.alerts[id];
    this.scheduler.scheduleTask(interval, async previousState => {
      if (alert.isMuted) {
        log(`Skipping check for ${id}, alert is muted`);
        return;
      }
      const fire = (context: any) => {
        log(`Firing actions for ${id}`);
        for (const action of actions) {
          const params = injectContextIntoObjectTemplatedStrings(action.params, context);
          this.actionService.fire(action.id, params);
        }
      };
      const services = { fire };
      return alert.execute(services, checkParams, previousState);
    });
  }
}

function injectContextIntoObjectTemplatedStrings(objectToResolve: any, objectToInject: any) {
  const params: any = {};
  for (const key of Object.keys(objectToResolve)) {
    params[key] = resolveTemplate(objectToResolve[key], objectToInject);
  }
  return params;
}

function resolveTemplate(str: string, object: any) {
  let result = str;
  for (const key of Object.keys(object)) {
    result = result.replace(`{${key}}`, object[key]);
  }
  return result;
}
