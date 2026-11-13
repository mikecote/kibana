/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart } from '@kbn/core/server';
import type { RulesReadClient } from '@kbn/alerting-plugin/server/rules_client/create_rules_read_client';
import type { StreamsPluginStartDependencies } from './types';

interface StreamsCoreStart {
  elasticsearch: Pick<CoreStart['elasticsearch'], 'client'> & {
    getCapabilities: () => Pick<
      ReturnType<CoreStart['elasticsearch']['getCapabilities']>,
      'serverless'
    >;
  };
  savedObjects: Pick<
    CoreStart['savedObjects'],
    'getScopedClient' | 'getTypeRegistry' | 'createInternalRepository'
  >;
  uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient' | 'globalAsScopedToClient'>;
}

type StreamsStartPlugins = Pick<
  StreamsPluginStartDependencies,
  'encryptedSavedObjects' | 'fieldsMetadata'
> & {
  inference: Pick<StreamsPluginStartDependencies['inference'], 'getClient'>;
  licensing: Pick<StreamsPluginStartDependencies['licensing'], 'getLicense'>;
  alerting: {
    getRulesClientWithRequest: (
      ...args: Parameters<StreamsPluginStartDependencies['alerting']['getRulesClientWithRequest']>
    ) => Promise<RulesReadClient>;
  };
};

/** The scoped Core and plugin services consumed by Streams' native clients. */
export interface StreamsStartServicesAccess {
  getStartServices: () => Promise<{
    readonly 0: StreamsCoreStart;
    readonly 1: StreamsStartPlugins;
  }>;
}
