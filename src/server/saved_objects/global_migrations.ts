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

/**
 * This file contains migrations that should apply to all types of saved objects
 */

import { get, set } from 'lodash';
import { TypeMigrationDefinition } from './migrations/core/document_migrator';
import { SavedObjectDoc } from './serialization';

const migrations = {
  '7.0.0': (doc: SavedObjectDoc) => {
    // Set new "references" attribute
    doc.references = doc.references || [];
    // Migrate index pattern
    const searchSourceJSON = get(doc, 'attributes.kibanaSavedObjectMeta.searchSourceJSON');
    if (
      typeof searchSourceJSON !== 'string' &&
      searchSourceJSON !== undefined &&
      searchSourceJSON !== null
    ) {
      throw new Error(`searchSourceJSON is not a string on ${doc.type || 'document'} "${doc.id}"`);
    }
    if (searchSourceJSON) {
      let searchSource;
      try {
        searchSource = JSON.parse(searchSourceJSON);
      } catch (e) {
        throw new Error(
          `Failed to parse searchSourceJSON: "${searchSourceJSON}" because "${
            e.message
          }" on ${doc.type || 'document'} "${doc.id}"`
        );
      }
      if (searchSource.index) {
        doc.references.push({
          name: 'kibanaSavedObjectMeta.searchSourceJSON.index',
          type: 'index-pattern',
          id: searchSource.index,
        });
        searchSource.indexRef = 'kibanaSavedObjectMeta.searchSourceJSON.index';
        delete searchSource.index;
        set(doc, 'attributes.kibanaSavedObjectMeta.searchSourceJSON', JSON.stringify(searchSource));
      }
    }
    return doc;
  },
};

export function getGlobalMigrations(): TypeMigrationDefinition {
  return migrations;
}
