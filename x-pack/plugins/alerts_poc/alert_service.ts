/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { Scheduler } from './scheduler';
import { ActionService } from './action_service';

// eslint-disable-next-line no-console
const log = (message: string, ...args: any) => console.log(`[alerts-poc][alert-service] ${message}`, ...args);

interface Alert {
  id: string;
  desc: string;
  isMuted: boolean;
  execute: (services: any, checkParams: any) => Promise<void>;
}

interface ScheduledAlert {
  id: string;
  interval: number;
  actions: Array<{
    id: string;
    context: any;
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
    this.scheduler.scheduleTask(interval, async () => {
      if (alert.isMuted) {
        log(`Skipping check for ${id}, alert is muted`);
        return;
      }
      const fire = () => {
        log(`Firing actions for ${id}`);
        for (const action of actions) {
          this.actionService.fire(action.id, action.context);
        }
      };
      const services = {
        fire
      };
      await alert.execute(services, checkParams);
    });
  }
}
