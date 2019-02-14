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

import { saveToFile } from './';
import stringify from 'json-stable-stringify';

export async function retrieveAndExportDocs(objs, savedObjectsClient) {
  // Sort by id to have same order of objects on each export
  const sortedObjects = [...objs].sort((a, b) => {
    if (a.id < b.id) {
      return -1;
    } else if (a.id > b.id) {
      return 1;
    }
    return 0;
  });
  const response = await savedObjectsClient.bulkGet(sortedObjects);
  const objects = response.savedObjects.map(obj => {
    return {
      _id: obj.id,
      _type: obj.type,
      _source: obj.attributes,
      _migrationVersion: obj.migrationVersion,
      _references: obj.references,
    };
  });

  saveToFile(stringify(objects, { space: 2 }));
}
