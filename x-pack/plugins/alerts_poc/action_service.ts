/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

const log = (message: string, ...args: any) =>
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [alerts-poc] [action-service] ${message}`, ...args);

import { SavedObjectsClient } from '../../../src/legacy/server/saved_objects';

interface Action {
  id: string;
  description: string;
  connector: string;
  attributes: any;
}

export class ActionService {
  connectors: { [key: string]: (context: any, params: any) => void };
  savedObjectsClient: SavedObjectsClient;

  constructor(savedObjectsClient: SavedObjectsClient) {
    this.connectors = {};
    this.savedObjectsClient = savedObjectsClient;
  }

  registerConnector(id: string, handler: (context: any, params: any) => void) {
    this.connectors[id] = handler;
    log(`Registered connector ${id}`);
  }

  async createAction(action: Action) {
    const { id, ...data } = action;
    await this.savedObjectsClient.create('action', data as any, { id, overwrite: true });
    log(`Registered ${id}`);
  }

  async fire(id: string, params: any) {
    const action = await this.savedObjectsClient.get('action', id);
    const { connector: connectorName, attributes: connectorOptions } = action.attributes;
    const handler = this.connectors[connectorName];
    await handler(connectorOptions, params);
  }
}
