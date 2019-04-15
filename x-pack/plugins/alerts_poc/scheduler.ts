/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

// eslint-disable-next-line no-console
const log = (message: string) => console.log(`[alerts-poc][scheduler] ${message}`);

export class Scheduler {
  scheduleTask(interval: number, callback: () => void) {
    setInterval(callback, interval);
    log(`Scheduled task to run every ${interval}ms`);
  }
}
