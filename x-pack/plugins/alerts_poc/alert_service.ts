/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { TaskManager, TaskId } from './task_manager';
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
  scheduledTasks: ScheduledAlertTask[];
}

interface ScheduledAlert {
  id: string;
  interval: number;
  actionGroups: Record<
    string,
    Array<{
      id: string;
      params: any;
    }>
  >;
  actionGroupsPriority: string[];
  checkParams: any;
  throttle?: number;
}

export class AlertService {
  taskManager: TaskManager;
  actionService: ActionService;
  alerts: { [key: string]: InternalAlert };

  constructor(actionService: ActionService, taskManager: TaskManager) {
    this.alerts = {};
    this.taskManager = taskManager;
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
      // todo: task manager needs to have disable/enable
      this.taskManager.clearTask(scheduledTask.taskId);
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
    const {
      id,
      interval,
      actionGroups,
      checkParams,
      throttle,
      actionGroupsPriority,
    } = scheduledAlert;
    const alert = this.alerts[id];
    let lastFired: { time: number; priority: number };
    const taskId = this.taskManager.scheduleTask(interval, async previousState => {
      const fire = (actionGroupId: string, context: any) => {
        log(`[fire] Firing actions for ${id}`);
        const actionGroupPriority = actionGroupsPriority.indexOf(actionGroupId);
        const actions = actionGroups[actionGroupId] || actionGroups.default || [];
        if (
          throttle &&
          lastFired &&
          (Date.now() - lastFired.time < throttle && lastFired.priority <= actionGroupPriority)
        ) {
          log('[fire] Firing is throttled, canceling');
          return;
        }
        for (const action of actions) {
          const templatedParams = Object.assign({}, alert.defaultActionParams, action.params);
          const params = injectContextIntoObjectTemplatedStrings(templatedParams, context);
          this.actionService.fire(action.id, params);
        }
        lastFired = {
          time: Date.now(),
          priority: actionGroupPriority,
        };
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
