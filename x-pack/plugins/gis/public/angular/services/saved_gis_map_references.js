/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

export function extractReferences({ attributes, references = [] }) {
  const extractedReferences = [];
  if (!attributes.layerListJSON) {
    return { attributes, references };
  }
  const layerList = JSON.parse(attributes.layerListJSON);
  layerList.forEach((layer, i) => {
    if (layer.sourceDescriptor && layer.sourceDescriptor.indexPatternId) {
      extractedReferences.push({
        name: `layer_${i}_index_pattern`,
        type: 'index-pattern',
        id: layer.sourceDescriptor.indexPatternId,
      });
      delete layer.sourceDescriptor.indexPatternId;
      layer.sourceDescriptor.indexPatternRefName = `layer_${i}_index_pattern`;
    }
  });
  return {
    attributes: {
      ...attributes,
      layerListJSON: JSON.stringify(layerList),
    },
    references: references.concat(extractedReferences),
  };
}

export function injectReferences(savedObject, references) {
  if (!savedObject.layerListJSON) {
    return;
  }
  const layerList = JSON.parse(savedObject.layerListJSON);
  layerList.forEach((layer) => {
    if (layer.sourceDescriptor && layer.sourceDescriptor.indexPatternRefName) {
      const reference = references.find(reference => reference.name === layer.sourceDescriptor.indexPatternRefName);
      if (!reference) {
        throw new Error(`Could not find reference "${layer.sourceDescriptor.indexPatternRefName}"`);
      }
      layer.sourceDescriptor.indexPatternId = reference.id;
      delete layer.sourceDescriptor.indexPatternRefName;
    }
  });
  savedObject.layerListJSON = JSON.stringify(layerList);
}
