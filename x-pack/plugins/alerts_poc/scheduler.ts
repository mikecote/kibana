/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`[alerts-poc][scheduler] ${message}`, ...args);

export class Scheduler {
  private tasks = new Map();
  private taskCounter = 0;

  scheduleTask(interval: number, callback: (previousState: Record<string, any>) => void) {
    const taskId = ++this.taskCounter;

    const intervalId = setInterval(async () => {
      const task = this.tasks.get(taskId);
      task.previousState = await callback(task.previousState);
    }, interval);

    this.tasks.set(taskId, {
      intervalId,
      previousState: {},
    });

    log(`Scheduled task to run every ${interval}ms`);

    return taskId;
  }

  disableTask(taskId: number) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Cannot find task by id [${taskId}]`);
    }
    clearInterval(task.taskId);
  }
}
