/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectReference } from '@kbn/core/server';
import type { GeoContainmentRuleParams, GeoContainmentExtractedRuleParams } from './types';

export function extractEntityAndBoundaryReferences(params: GeoContainmentRuleParams): {
  params: GeoContainmentExtractedRuleParams;
  references: SavedObjectReference[];
} {
  const { indexId, boundaryIndexId, ...otherParams } = params;

  //  Reference names omit the `param:`-prefix. This is handled by the alerting framework already
  const references = [
    {
      name: `tracked_index_${indexId}`,
      type: 'index-pattern',
      id: indexId as string,
    },
    {
      name: `boundary_index_${boundaryIndexId}`,
      type: 'index-pattern',
      id: boundaryIndexId as string,
    },
  ];
  return {
    params: {
      ...otherParams,
      indexRefName: `tracked_index_${indexId}`,
      boundaryIndexRefName: `boundary_index_${boundaryIndexId}`,
    },
    references,
  };
}

export function injectEntityAndBoundaryIds(
  params: GeoContainmentExtractedRuleParams,
  references: SavedObjectReference[]
): GeoContainmentRuleParams {
  const { indexRefName, boundaryIndexRefName, ...otherParams } = params;
  const { id: indexId = null } = references.find((ref) => ref.name === indexRefName) || {};
  const { id: boundaryIndexId = null } =
    references.find((ref) => ref.name === boundaryIndexRefName) || {};
  if (!indexId) {
    throw new Error(`Index "${indexId}" not found in references array`);
  }
  if (!boundaryIndexId) {
    throw new Error(`Boundary index "${boundaryIndexId}" not found in references array`);
  }
  return {
    ...otherParams,
    indexId,
    boundaryIndexId,
  } as GeoContainmentRuleParams;
}
