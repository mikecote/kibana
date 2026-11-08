/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreStart, IClusterClient } from '@kbn/core/server';
import type { LlmTasksPluginStart } from '@kbn/llm-tasks-plugin/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';

/** The scoped Core, Spaces and documentation services consumed by Security's core tools. */
export interface SecurityCoreToolServices {
  getStartServices: () => Promise<
    [
      {
        elasticsearch: { client: Pick<IClusterClient, 'asInternalUser'> };
        http: Pick<CoreStart['http'], 'basePath' | 'selfClient'>;
        uiSettings: Pick<CoreStart['uiSettings'], 'asScopedToClient'>;
      },
      { spaces?: Pick<SpacesPluginStart, 'spacesService'>; llmTasks?: LlmTasksPluginStart },
      object?
    ]
  >;
}
