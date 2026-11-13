/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ApmSourcesAccessPluginSetup } from '@kbn/apm-sources-access-plugin/server';
import type { ApmDataAccessPluginSetup } from './types';
import { getServices } from './services/get_services';

/** Builds the native APM data services over the configured source resolver. */
export const createApmDataAccessServices = (
  sources: ApmSourcesAccessPluginSetup
): ApmDataAccessPluginSetup => ({
  apmIndicesFromConfigFile: sources.apmIndicesFromConfigFile,
  getApmIndices: sources.getApmIndices,
  getServices,
});
