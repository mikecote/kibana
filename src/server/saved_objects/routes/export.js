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

import { Readable } from 'stream';

import { createToJsonBufferStream } from '../../../utils/streams/json_streams';
import { createQueryIndexStream } from '../lib/query_index_stream';

export const createExportRoute = (prereqs) => ({
  path: '/api/saved_objects/_export',
  method: 'POST',
  config: {
    pre: [prereqs.getSavedObjectsClient],
    handler(request, h) {
      const { savedObjectsClient } = request.pre;
      const readStream = new Readable({ objectMode: true });
      const queryIndexStream = createQueryIndexStream(savedObjectsClient);
      const toJsonStream = createToJsonBufferStream();
      const result = readStream
        .pipe(queryIndexStream)
        .on('error', err => toJsonStream.emit('error', err))
        .pipe(toJsonStream);
      readStream.push(request.payload || {});
      readStream.push(null);
      return h
        .response(result)
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', 'attachment; filename=export.json');
    }
  }
});
