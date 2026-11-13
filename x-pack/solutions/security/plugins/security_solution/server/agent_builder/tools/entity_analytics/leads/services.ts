/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PluginStartContract as ActionsPluginStart } from '@kbn/actions-plugin/server';
import type { InferenceServerStart } from '@kbn/inference-plugin/server';
import type { SecurityEntityToolServices } from '../entity_services';

type EntityStart = Awaited<ReturnType<SecurityEntityToolServices['getStartServices']>>;

/** Execution services used by lead generation and its completion lifecycle. */
export interface SecurityLeadToolServices extends SecurityEntityToolServices {
  trackBackgroundTask?: (task: Promise<void>) => void;
  getStartServices: () => Promise<
    [
      EntityStart[0],
      EntityStart[1] & {
        actions: Pick<ActionsPluginStart, 'getActionsClientWithRequest'>;
        inference: InferenceServerStart;
      },
      object?
    ]
  >;
}
