/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { ActionService } from './action_service';

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [alerts-poc] [alert-service] ${message}`, ...args);

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
  taskManager: any;
  actionService: ActionService;
  serviceId: number; // This is to avoid persisting scheduled alerts.. for now

  constructor(actionService: ActionService, taskManager: any) {
    this.actionService = actionService;
    this.taskManager = taskManager;
    this.serviceId = Date.now();
  }

  register(alert: Alert) {
    this.taskManager.registerTaskDefinitions({
      [`alert:${alert.id}`]: {
        title: alert.desc,
        type: `alert:${alert.id}`,
        timeout: '1m',
        numWorkers: 1,
        createTaskRunner: this.createTaskRunner(alert),
      },
    });
    log(`Registered ${alert.id}`);
  }

  schedule(scheduledAlert: ScheduledAlert) {
    this.taskManager.schedule({
      id: scheduledAlert.id,
      taskType: `alert:${scheduledAlert.id}`,
      params: {
        ...scheduledAlert,
        serviceId: this.serviceId,
      },
      state: {},
    });
  }

  shouldThrottle(actionGroupPriority: number, taskInstance: any) {
    return (
      taskInstance.params.throttle &&
      taskInstance.state.lastFired &&
      (Date.now() - taskInstance.state.lastFired.time < taskInstance.params.throttle &&
        taskInstance.state.lastFired.priority <= actionGroupPriority)
    );
  }

  createFireHandler(alert: Alert, taskInstance: any) {
    return (actionGroupId: string, context: any, state: any) => {
      log(`[fire] Firing actions for ${taskInstance.params.id}`);

      // Throttling
      const actionGroupPriority = taskInstance.params.actionGroupsPriority.indexOf(actionGroupId);
      const shouldThrottle = this.shouldThrottle(actionGroupPriority, taskInstance);
      if (shouldThrottle) {
        log('[fire] Firing is throttled, canceling');
        return;
      }

      // Firing actions
      const actions =
        taskInstance.params.actionGroups[actionGroupId] ||
        taskInstance.params.actionGroups.default ||
        [];
      for (const action of actions) {
        const templatedParams = Object.assign({}, alert.defaultActionParams, action.params);
        const params = injectContextIntoObjectTemplatedStrings(templatedParams, context);
        this.actionService.fire(action.id, params);
      }

      state.lastFired = {
        time: Date.now(),
        priority: actionGroupPriority,
      };
    };
  }

  createTaskRunner(alert: Alert) {
    const { serviceId } = this;
    return ({ taskInstance }: { taskInstance: any }) => {
      const services = {
        fire: this.createFireHandler(alert, taskInstance),
      };
      return {
        async run() {
          try {
            if (taskInstance.params.serviceId !== serviceId) {
              log('Skipping task from different serviceId');
              return { state: taskInstance.state };
            }
            log('Running task');
            const updatedState = await alert.execute(
              services,
              taskInstance.params.checkParams,
              taskInstance.state
            );
            return {
              state: updatedState,
              runAt: taskInstance.params.interval
                ? Date.now() + taskInstance.params.interval
                : undefined,
            };
          } catch (err) {
            return {
              state: taskInstance.state,
              error: { message: err.message },
            };
          }
        },
      };
    };
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
