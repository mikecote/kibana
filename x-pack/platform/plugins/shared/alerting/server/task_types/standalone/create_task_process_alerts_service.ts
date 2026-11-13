/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of, ReplaySubject } from 'rxjs';
import type { Logger } from '@kbn/core/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server';
import type { AlertingConfig } from '../../config';
import { AlertsService } from '../../alerts_service/alerts_service';
import { getDataStreamAdapter } from '../../alerts_service/lib/data_stream_adapter';

/** Creates the native framework alerts service used by rule execution and previews. */
export const createTaskProcessAlertsService = (
  host: Pick<TaskHost, 'elasticsearch' | 'server' | 'onRunEnd'>,
  config: AlertingConfig,
  logger: Logger
): AlertsService | null => {
  if (!config.enableFrameworkAlerts) return null;
  const pluginStop$ = new ReplaySubject<void>(1);
  host.onRunEnd?.(async () => {
    pluginStop$.next();
    pluginStop$.complete();
  });
  const { isServerless, version: kibanaVersion, uuid: serverUuid } = host.server;
  return new AlertsService({
    logger,
    pluginStop$,
    kibanaVersion,
    serverUuid,
    dataStreamAdapter: getDataStreamAdapter({ useDataStreamForAlerts: isServerless }),
    elasticsearchClientPromise: Promise.resolve(host.elasticsearch.asInternalUser),
    elasticsearchAndSOAvailability$: of(true),
    isServerless,
    totalFieldsLimit: config.alertsService.totalFieldsLimit,
  });
};
