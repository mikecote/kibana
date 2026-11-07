/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup } from '@kbn/core/server';
import type { StreamsPluginStartDependencies } from './types';

/**
 * What the streams services read of `CoreSetup`: the start services, read lazily. In Kibana it is
 * `core`; a task process gives its own (Core's building blocks and the services it builds).
 */
export type StreamsStartServicesAccess = Pick<
  CoreSetup<StreamsPluginStartDependencies>,
  'getStartServices'
>;
