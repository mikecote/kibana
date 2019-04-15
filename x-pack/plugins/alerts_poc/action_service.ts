/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

// eslint-disable-next-line no-console
const log = (message: string, ...args: any) => console.log(`[alerts-poc][action-service] ${message}`, ...args);

interface Action {
  id: string;
  fire: (context: any) => void;
}

export class ActionService {
  actions: { [key: string]: Action };

  constructor() {
    this.actions = {};
  }

  register(action: Action) {
    this.actions[action.id] = action;
    log(`Registered ${action.id}`);
  }

  async fire(id: string, context: any) {
    const fn = this.actions[id].fire;
    await fn(context);
  }
}
