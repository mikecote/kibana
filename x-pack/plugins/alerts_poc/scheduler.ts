/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`[alerts-poc][scheduler] ${message}`, ...args);

export class Scheduler {
  private taskState = new Map();

  scheduleTask(interval: number, callback: (previousState: Record<string, any>) => void) {
    const intervalId = setInterval(async () => {
      const newState = await callback(this.taskState.get(intervalId));
      this.taskState.set(intervalId, newState);
    }, interval);

    this.taskState.set(intervalId, {});

    log(`Scheduled task to run every ${interval}ms`);
  }
}
