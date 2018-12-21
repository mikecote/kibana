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

import { groupBy } from 'lodash';

export async function findRelationships(type, id, size, savedObjectsClient) {
  const obj = await savedObjectsClient.get(type, id);
  const references = groupBy(obj.references, 'type');
  for (const type of Object.keys(references)) {
    const bulkGetResp = await savedObjectsClient.bulkGet(
      references[type].map(ref => ({ id: ref.id, type }))
    );
    const { saved_objects: savedObjects } = bulkGetResp;
    references[type] = savedObjects.map(obj => ({ id: obj.id, type: obj.type, ...obj.attributes }));
  }
  return references;
}
