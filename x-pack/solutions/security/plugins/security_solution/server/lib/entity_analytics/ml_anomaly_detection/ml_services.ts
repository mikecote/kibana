/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { MlPluginSetup } from '@kbn/ml-plugin/server';

/** ML providers used by entity enrichment and anomaly analysis. */
export type EntityAnalyticsMlServices = Pick<
  MlPluginSetup,
  | 'jobServiceProvider'
  | 'resultsServiceProvider'
  | 'modulesProvider'
  | 'mlSystemProvider'
  | 'anomalyDetectorsProvider'
>;
