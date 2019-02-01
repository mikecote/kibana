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

import Joi from 'joi';
import { Transform } from 'stream';
import {
  createListStream,
  createJsonStringifyStream,
  createIntersperseStream,
  createResolveObjectsStream,
} from '../../../utils/streams';

// Export route
export const createExportRoute = (prereqs) => ({
  path: '/api/saved_objects/_export',
  method: 'GET',
  config: {
    pre: [prereqs.getSavedObjectsClient],
    validate: {
      query: Joi.object().keys({
        type: Joi.array().items(Joi.string()).single().optional(),
        objects: Joi.array().items({
          type: Joi.string().required(),
          id: Joi.string().required(),
        }).optional(),
      }).default(),
    },
    async handler(request, h) {
      const { savedObjectsClient } = request.pre;
      const readStream = request.query.objects
        ? createListStream(request.query.objects)
          .pipe(createResolveObjectsStream(savedObjectsClient))
        : await savedObjectsClient.findAsStream({
          type: request.query.type,
        });
      const toResponseStream = new Transform({
        writableObjectMode: true,
        readableObjectMode: false,
        transform(obj, enc, done) {
          done(null, obj);
        },
      });
      return h
        .response(
          readStream
            .pipe(createJsonStringifyStream())
            .pipe(createIntersperseStream('\n'))
            .pipe(toResponseStream),
        )
        .header('Content-Disposition', `attachment; filename="export.json"`);
    },
  },
});
