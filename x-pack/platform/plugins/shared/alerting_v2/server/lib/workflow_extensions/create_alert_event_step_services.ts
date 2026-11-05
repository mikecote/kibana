/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ElasticsearchClient,
  FeatureFlagsStart,
  KibanaRequest,
  Logger,
} from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin-types-server';
import { AlertEventsClient } from '../alert_events_client';
import { EsqlResponseFormatService } from '../services/esql_response_format_service/esql_response_format_service';
import { LoggerService } from '../services/logger_service/logger_service';
import { PrivilegeChecker } from '../services/privilege_checker/privilege_checker';
import { QueryService } from '../services/query_service/query_service';
import type { ResourceManagerContract } from '../services/resource_service/resource_manager';
import { StorageService } from '../services/storage_service/storage_service';
import type { AlertEventsClientApi } from '../../types';

const onlyInKibana = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

export interface CreateAlertEventStepServicesOptions {
  /** The internal user client, which the alert events client writes and queries with. */
  esClient: ElasticsearchClient;
  logger: Logger;
  featureFlags: Pick<FeatureFlagsStart, 'getStringValue$'>;
  security: Pick<SecurityPluginStart, 'authz'>;
}

/**
 * What the `alertingVTwo.createAlertEvent` step reads, built by hand from explicit dependencies, with
 * the classes the plugin's container builds for Kibana: the alert events client and the privilege
 * checker of a request. A task process has no container. Its resources (the alert events data
 * stream and its ingest pipeline) are Kibana's to install at startup, so they are taken as ready.
 */
export const createAlertEventStepServices = ({
  esClient,
  logger,
  featureFlags,
  security,
}: CreateAlertEventStepServicesOptions) => {
  const loggerService = new LoggerService(logger);
  const queryService = new QueryService(
    esClient,
    loggerService,
    new EsqlResponseFormatService(featureFlags as FeatureFlagsStart, loggerService)
  );
  const storageService = new StorageService(esClient, loggerService);
  const resourceManager: ResourceManagerContract = {
    registerResource: onlyInKibana('Registering a resource'),
    startInitialization: onlyInKibana('Starting the initialization of resources'),
    waitUntilReady: async () => {},
    isReady: () => true,
    ensureResourceReady: async () => {},
  };
  const getSpaceId = (request: KibanaRequest) =>
    (request as { spaceId?: string }).spaceId ?? 'default';

  return {
    getAlertEventsClient: async (request: KibanaRequest): Promise<AlertEventsClientApi> =>
      new AlertEventsClient(storageService, queryService, getSpaceId(request), resourceManager),
    checkAlertWritePrivilege: (request: KibanaRequest): Promise<boolean> =>
      new PrivilegeChecker(request, getSpaceId(request), security as SecurityPluginStart).canWrite(
        'alerts'
      ),
  };
};
