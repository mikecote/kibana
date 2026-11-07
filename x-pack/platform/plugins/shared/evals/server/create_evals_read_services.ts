/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { EvaluatorRegistry } from './evaluators/types';
import type { EvalsPluginStart } from './types';

/** The evaluators of a space, as the start contract of the plugin lists them. */
export const createListEvaluators =
  (evaluatorRegistry: EvaluatorRegistry): NonNullable<EvalsPluginStart['listEvaluators']> =>
  async ({ spaceId }) => {
    const definitions = await evaluatorRegistry.asScoped({ spaceId }).list();

    return definitions.map((def) => ({
      name: def.name,
      version: def.version,
      kind: def.kind,
      origin: def.origin,
      description: def.description,
      needsJudgeConnector: def.kind === 'llm',
    }));
  };

/** The connectors a request may use as models, as the start contract of the plugin lists them. */
export const createListModelConnectors =
  (
    getConnectorList: (
      request: KibanaRequest
    ) => Promise<Array<{ connectorId: string; name: string; type: string }>>
  ): NonNullable<EvalsPluginStart['listModelConnectors']> =>
  async (request) => {
    const connectors = await getConnectorList(request);
    return connectors.map((connector) => ({
      id: connector.connectorId,
      name: connector.name,
      type: connector.type,
    }));
  };
