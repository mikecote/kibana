/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { normalizeConnectorFeatureIds } from '@kbn/search-inference-endpoints/server/lib/resolve_connector_id_from_features';

/**
 * Why a step that names inference features (`connector-id-by-feature`) cannot be served by a task
 * process as Kibana serves it, or `undefined`. Kibana skips an id that is not registered, so a
 * process that lacks a feature another plugin registers would fall back to the default connector
 * instead of the one configured for it: the run is declined and Kibana runs it.
 */
export const checkConnectorFeatures = (
  config: Record<string, unknown>,
  isFeatureRegistered: (featureId: string) => boolean
): string | undefined => {
  const value = config['connector-id-by-feature'];
  if (value === undefined) return undefined;
  for (const featureId of normalizeConnectorFeatureIds(value)) {
    if (featureId.includes('{{')) {
      return `connector-id-by-feature "${featureId}" is a template, which is only known when the step runs`;
    }
    if (!isFeatureRegistered(featureId)) {
      return `the inference feature "${featureId}" is not registered in this process`;
    }
  }
  return undefined;
};
