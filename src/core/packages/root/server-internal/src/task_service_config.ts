/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type { ConfigService } from '@kbn/config';
import { config as pathConfig } from '@kbn/utils';
import { coreDeprecationProvider } from '@kbn/core-config-server-internal';
import { config as loggingConfig } from '@kbn/core-logging-server-internal';
import { nodeConfig } from '@kbn/core-node-server-internal';
import { pidConfig } from '@kbn/core-environment-server-internal';
import { executionContextConfig } from '@kbn/core-execution-context-server-internal';
import {
  config as httpConfig,
  cspConfig,
  externalUrlConfig,
  permissionsPolicyConfig,
} from '@kbn/core-http-server-internal';
import { config as elasticsearchConfig } from '@kbn/core-elasticsearch-server-internal';
import {
  savedObjectsConfig,
  savedObjectsMigrationConfig,
} from '@kbn/core-saved-objects-base-server-internal';
import { config as i18nConfig } from '@kbn/core-i18n-server-internal';
import { statusConfig } from '@kbn/core-status-server-internal';
import { uiSettingsConfig } from '@kbn/core-ui-settings-server-internal';
import { config as pluginsConfig } from '@kbn/core-plugins-server-internal';
import { elasticApmConfig } from './root/elastic_config';
import { serverlessConfig } from './root/serverless_config';
import { airgappedConfig } from './root/airgapped_config';
import { coreConfig } from './core_config';

/** Registers the normal Core schemas used by a task process. */
export const registerTaskServiceConfig = (configService: ConfigService): void => {
  configService.addDeprecationProvider('', coreDeprecationProvider);
  const descriptors = [
    pathConfig,
    loggingConfig,
    nodeConfig,
    pidConfig,
    executionContextConfig,
    httpConfig,
    cspConfig,
    externalUrlConfig,
    permissionsPolicyConfig,
    elasticsearchConfig,
    savedObjectsConfig,
    savedObjectsMigrationConfig,
    i18nConfig,
    statusConfig,
    uiSettingsConfig,
    pluginsConfig,
    elasticApmConfig,
    serverlessConfig,
    airgappedConfig,
    coreConfig,
  ];
  for (const descriptor of descriptors) {
    if ('deprecations' in descriptor && descriptor.deprecations)
      configService.addDeprecationProvider(descriptor.path, descriptor.deprecations);
    configService.setSchema(descriptor.path, descriptor.schema);
  }
};
