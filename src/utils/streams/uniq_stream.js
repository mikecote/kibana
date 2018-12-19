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

import { identity } from 'lodash';
import { Transform } from 'stream';

/**
 * Create a Transform stream that removes duplicate values
 *
 * @param {Function} [iteratee] - Function to return a comparable string or number
 * @returns {Transform}
 */
export function createUniqStream(iteratee = identity) {
  const processedObjects = [];
  return new Transform({
    objectMode: true,
    transform(value, enc, done) {
      const criterion = iteratee(value);
      if (typeof criterion === 'object') {
        done(new Error('Iteratee cannot be an object'));
        return;
      }
      if (processedObjects.indexOf(criterion) === -1) {
        processedObjects.push(criterion);
        this.push(value);
      }
      done();
    }
  });
}
