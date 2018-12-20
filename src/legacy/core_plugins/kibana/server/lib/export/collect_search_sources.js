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

import { find } from 'lodash';
import { collectIndexPatterns } from './collect_index_patterns';

export async function collectSearchSources(savedObjectsClient, panels) {
  const docs = panels.reduce((acc, panel) => {
    const { savedSearchRef } = panel.attributes;
    if (savedSearchRef) {
      const savedSearch = find(panel.references, { name: savedSearchRef });
      if (savedSearch && !acc.find(s => s.id === savedSearch.id) && !panels.find(p => p.id === savedSearch.id)) {
        acc.push({ type: 'search', id: savedSearch.id });
      }
    }
    return acc;
  }, []);

  if (docs.length === 0) return [];

  const { saved_objects: savedObjects } = await savedObjectsClient.bulkGet(docs);
  const indexPatterns = await collectIndexPatterns(savedObjectsClient, savedObjects);

  return savedObjects.concat(indexPatterns);
}
