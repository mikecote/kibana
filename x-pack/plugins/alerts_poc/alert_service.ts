/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { Scheduler, TaskId } from './scheduler';
import { ActionService } from './action_service';

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [alerts-poc] [alert-service] ${message}`, ...args);

interface ScheduledAlertTask {
  scheduledAlert: ScheduledAlert;
  taskId?: TaskId;
}

interface Alert {
  id: string;
  desc: string;
  defaultActionParams: {
    subject: string;
    body: string;
    message: string;
  };
  execute: (services: any, checkParams: any, previousState: any) => Promise<Record<string, any>>;
}

interface InternalAlert extends Alert {
  scheduledTasks: Array<ScheduledAlertTask>;
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
  alerts: { [key: string]: InternalAlert };

  constructor(actionService: ActionService) {
    this.alerts = {};
    this.scheduler = new Scheduler();
    this.actionService = actionService;
  }

  register(alert: Alert) {
    this.alerts[alert.id] = {
      ...alert,
      scheduledTasks: [],
    };
    log(`Registered ${alert.id}`);
  }

  disable(id: string) {
    log(`[disable] disabling all scheduled tasks for alert "${id}"`);
    this.alerts[id].scheduledTasks.forEach(scheduledTask => {
      if (!scheduledTask.taskId) {
        return;
      }
      this.scheduler.clearTask(scheduledTask.taskId);
      scheduledTask.taskId = undefined;
    });
  }

  enable(id: string) {
    log(`[enable] enabling all scheduled tasks for alert "${id}"`);
    this.alerts[id].scheduledTasks.forEach(scheduledTask => {
      if (scheduledTask.taskId) {
        return;
      }
      this.schedule(scheduledTask.scheduledAlert);
    });
  }

  schedule(scheduledAlert: ScheduledAlert) {
    const { id, interval, actions, checkParams } = scheduledAlert;
    const alert = this.alerts[id];
    const taskId = this.scheduler.scheduleTask(interval, async previousState => {
      const fire = (context: any) => {
        log(`Firing actions for ${id}`);
        for (const action of actions) {
          const templatedParams = Object.assign({}, alert.defaultActionParams, action.params);
          const params = injectContextIntoObjectTemplatedStrings(templatedParams, context);
          this.actionService.fire(action.id, params);
        }
      };
      const services = { fire };
      return alert.execute(services, checkParams, previousState);
    });
    alert.scheduledTasks.push({
      scheduledAlert,
      taskId,
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
