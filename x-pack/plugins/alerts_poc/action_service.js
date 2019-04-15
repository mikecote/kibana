/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const log = (message) => console.log(`[alerts-poc][action-service] ${message}`);

export class ActionService {
  constructor() {
    this.actions = {};
  }
  register(action) {
    this.actions[action.id] = action;
    log(`Registered ${action.id}`);
  }
  createFireFn(id, args) {
    const fn = this.actions[id].fire;
    return async () => await fn(args);
  }
}
