/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

export class Scheduler {
  constructor() {
    this.tasks = [];
  }
  scheduleTask({ interval, callback }) {
    setInterval(callback, interval);
  }
}
