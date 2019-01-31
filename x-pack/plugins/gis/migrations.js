/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

export const migrations = {
  'gis-map': {
    '7.0.0': (doc) => {
      // Set new "references" attribute
      doc.references = doc.references || [];
      // Migrate index patterns
      if (!doc.attributes || typeof doc.attributes.layerListJSON !== 'string') {
        return doc;
      }
      let layerList;
      try {
        layerList = JSON.parse(doc.attributes.layerListJSON);
      } catch (e) {
        // Let it go, the data is invalid and we'll leave it as is
        return doc;
      }
      layerList.forEach((layer, i) => {
        if (layer.sourceDescriptor && layer.sourceDescriptor.indexPatternId) {
          doc.references.push({
            name: `layer_${i}_index_pattern`,
            type: 'index-pattern',
            id: layer.sourceDescriptor.indexPatternId,
          });
          delete layer.sourceDescriptor.indexPatternId;
          layer.sourceDescriptor.indexPatternRefName = `layer_${i}_index_pattern`;
        }
      });
      doc.attributes.layerListJSON = JSON.stringify(layerList);
      return doc;
    },
  },
};
