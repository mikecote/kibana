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

import { Transform } from 'stream';

// Resolve objects stream
export function createResolveObjectsStream(savedObjectsClient) {
  return new Transform({
    objectMode: true,
    async transform(obj, enc, done) {
      try {
        const savedObject = await savedObjectsClient.get(obj.type, obj.id);
        done(null, savedObject);
      } catch (e) {
        done(e);
      }
    },
    async writev(chunks, done) {
      try {
        const bulkGetOptions = chunks.map(row => row.chunk);
        const { saved_objects: savedObjects } = await savedObjectsClient.bulkGet(bulkGetOptions);
        savedObjects.forEach(row => this.push(row));
        done();
      } catch (e) {
        done(e);
      }
    }
  });
}
