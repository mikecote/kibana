/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [alerts-poc] [action-service] ${message}`, ...args);

interface Action {
  id: string;
  description: string;
  connector: string;
  attributes: any;
}

export class ActionService {
  actions: { [key: string]: Action };
  connectors: { [key: string]: (context: any, params: any) => void };

  constructor() {
    this.actions = {};
    this.connectors = {};
  }

  registerConnector(id: string, handler: (context: any, params: any) => void) {
    this.connectors[id] = handler;
    log(`Registered connector ${id}`);
  }

  createAction(action: Action) {
    this.actions[action.id] = action;
    log(`Registered ${action.id}`);
  }

  async fire(id: string, params: any) {
    const { connector: connectorName, attributes: connectorOptions } = this.actions[id];
    const hander = this.connectors[connectorName];
    await hander(connectorOptions, params);
  }
}
