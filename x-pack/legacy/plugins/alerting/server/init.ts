/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { Legacy } from 'kibana';
import {
  createAlertRoute,
  deleteAlertRoute,
  findRoute,
  getRoute,
  listAlertTypesRoute,
  updateAlertRoute,
  enableAlertRoute,
  disableAlertRoute,
} from './routes';
import { AlertingPlugin, Services } from './types';
import { AlertTypeRegistry } from './alert_type_registry';
import { AlertsClient } from './alerts_client';

export function init(server: Legacy.Server) {
  const { taskManager } = server;
  const { callWithRequest } = server.plugins.elasticsearch.getCluster('admin');

  // Encrypted attributes
  server.plugins.encrypted_saved_objects!.registerType({
    type: 'alert',
    attributesToEncrypt: new Set(['apiKeyId', 'generatedApiKey']),
    attributesToExcludeFromAAD: new Set([
      'enabled',
      'alertTypeId',
      'interval',
      'actions',
      'alertTypeParams',
      'scheduledTaskId',
    ]),
  });

  function getServices(request: any): Services {
    return {
      log: (...args) => server.log(...args),
      callCluster: (...args) => callWithRequest(request, ...args),
      savedObjectsClient: server.savedObjects.getScopedSavedObjectsClient(request),
    };
  }

  const alertTypeRegistry = new AlertTypeRegistry({
    getServices,
    taskManager: taskManager!,
    fireAction: server.plugins.actions!.fire,
    encryptedSavedObjectsPlugin: server.plugins.encrypted_saved_objects!,
    getBasePath: server.plugins.spaces ? server.plugins.spaces.getBasePath : () => undefined,
    spaceIdToNamespace: server.plugins.spaces
      ? server.plugins.spaces.spaceIdToNamespace
      : () => undefined,
  });

  // Register routes
  createAlertRoute(server);
  deleteAlertRoute(server);
  findRoute(server);
  getRoute(server);
  listAlertTypesRoute(server);
  updateAlertRoute(server);
  enableAlertRoute(server);
  disableAlertRoute(server);

  // Expose functions
  server.decorate('request', 'getAlertsClient', function() {
    const request = this;
    const savedObjectsClient = request.getSavedObjectsClient();
    const alertsClient = new AlertsClient({
      log: server.log.bind(server),
      savedObjectsClient,
      alertTypeRegistry,
      taskManager: taskManager!,
      spaceId: request.server.plugins.spaces && request.server.plugins.spaces.getSpaceId(request),
    });
    return alertsClient;
  });
  const exposedFunctions: AlertingPlugin = {
    registerType: alertTypeRegistry.register.bind(alertTypeRegistry),
    listTypes: alertTypeRegistry.list.bind(alertTypeRegistry),
  };
  server.expose(exposedFunctions);
}
