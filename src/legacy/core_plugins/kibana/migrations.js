/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { get } from 'lodash';

export default {
  search: {
    '7.0.0': (doc) => {
      // Set new "references" attribute
      doc.references = doc.references || [];
      // Migrate index pattern
      const searchSourceJSON = get(doc, 'attributes.kibanaSavedObjectMeta.searchSourceJSON');
      if (typeof searchSourceJSON !== 'string') {
        throw new Error(`searchSourceJSON is ${searchSourceJSON ? 'not a string' : 'missing'} on document "${doc.id}"`);
      }
      let searchSource;
      try {
        searchSource = JSON.parse(searchSourceJSON);
      } catch (e) {
        throw new Error(`Failed to parse searchSourceJSON: "${searchSourceJSON}" because "${e.message}" on document "${doc.id}"`);
      }
      if (!searchSource.index) {
        throw new Error(`"index" attribute is missing within searchSourceJSON on document "${doc.id}"`);
      }
      doc.references.push({
        name: 'indexPattern',
        type: 'index-pattern',
        id: searchSource.index,
      });
      searchSource.indexRef = 'indexPattern';
      delete searchSource.index;
      doc.attributes.kibanaSavedObjectMeta.searchSourceJSON = JSON.stringify(searchSource);
      return doc;
    },
  },
  visualization: {
    '7.0.0': (doc) => {
      const savedSearchId = get(doc, 'attributes.savedSearchId');
      const searchSourceJSON = get(doc, 'attributes.kibanaSavedObjectMeta.searchSourceJSON');
      // Set new "references" attribute
      doc.references = doc.references || [];
      // Migrate index pattern
      if (typeof searchSourceJSON !== 'string') {
        throw new Error(`searchSourceJSON is ${searchSourceJSON ? 'not a string' : 'missing'} on document "${doc.id}"`);
      }
      let searchSource;
      try {
        searchSource = JSON.parse(searchSourceJSON);
      } catch (e) {
        throw new Error(`Failed to parse searchSourceJSON: "${searchSourceJSON}" because "${e.message}" on document "${doc.id}"`);
      }
      const hasSearchSourceIndex = !!searchSource.index;
      if (searchSource.index) {
        doc.references.push({
          name: 'indexPattern',
          type: 'index-pattern',
          id: searchSource.index,
        });
        searchSource.indexRef = 'indexPattern';
        delete searchSource.index;
        doc.attributes.kibanaSavedObjectMeta.searchSourceJSON = JSON.stringify(searchSource);
      }
      // Migrate saved search
      if (savedSearchId) {
        doc.references.push({
          type: 'search',
          name: 'search_0',
          id: savedSearchId
        });
        doc.attributes.savedSearchRef = 'search_0';
        delete doc.attributes.savedSearchId;
      }
      // Validate
      if (!hasSearchSourceIndex && !savedSearchId) {
        throw new Error('At least one of the following attributes must be provided ' +
          `["attributes.savedSearchId","attributes.kibanaSavedObjectMeta.searchSourceJSON.index"] on document "${doc.id}"`);
      }
      return doc;
    }
  },
  dashboard: {
    '7.0.0': (doc) => {
      // Set new "references" attribute
      doc.references = doc.references || [];
      // Migrate panels
      const panelsJSON = get(doc, 'attributes.panelsJSON');
      if (typeof panelsJSON !== 'string') {
        throw new Error(`panelsJSON is ${panelsJSON ? 'not a string' : 'missing'} on document "${doc.id}"`);
      }
      let panels;
      try {
        panels = JSON.parse(panelsJSON);
      } catch (e) {
        throw new Error(`Failed to parse panelsJSON: "${panelsJSON}" because "${e.message}" on document "${doc.id}"`);
      }
      panels.forEach((panel, i) => {
        panel.panelRef = `panel_${i}`;
        if (!panel.type) {
          throw new Error(`"type" attribute is missing from panel "${i}" on document "${doc.id}"`);
        }
        if (!panel.id) {
          throw new Error(`"id" attribute is missing from panel "${i}" on document "${doc.id}"`);
        }
        doc.references.push({
          name: `panel_${i}`,
          type: panel.type,
          id: panel.id
        });
        delete panel.type;
        delete panel.id;
      });
      doc.attributes.panelsJSON = JSON.stringify(panels);
      return doc;
    }
  }
};
