/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { find } from 'lodash';

export function extractReferences({ attributes, references = [] }) {
  // For some reason, wsState comes in stringified 2x
  const state = JSON.parse(JSON.parse(attributes.wsState));
  const { indexPattern } = state;
  if (!indexPattern) {
    throw new Error('indexPattern attribute is missing in "wsState"');
  }
  state.indexPatternRef = 'indexPattern_0';
  delete state.indexPattern;
  return {
    references: [
      ...references,
      {
        name: 'indexPattern_0',
        type: 'index-pattern',
        id: indexPattern,
      }
    ],
    attributes: {
      ...attributes,
      wsState: JSON.stringify(JSON.stringify(state))
    }
  };
}

export function injectReferences(references) {
  const state = JSON.parse(this.wsState);
  if (!state.indexPatternRef) {
    throw new Error('indexPatternRef attribute is missing from "wsState"');
  }
  const indexPatternReference = find(references, { name: state.indexPatternRef });
  if (!indexPatternReference) {
    throw new Error(`Could not find reference "${state.indexPatternRef}"`);
  }
  state.indexPattern = indexPatternReference.id;
  delete state.indexPatternRef;
  this.wsState = JSON.stringify(state);
}
