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

import { pick } from 'lodash';

import {
  createUniqStream,
  createListStream,
  createConcatStream,
  createPromiseFromStreams
} from './';

describe('createUniqStream()', () => {
  test('removes duplicate numbers', async () => {
    const results = await createPromiseFromStreams([
      createListStream([1, 2, 2, 3]),
      createUniqStream(),
      createConcatStream([])
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  test('removes duplicate strings', async () => {
    const results = await createPromiseFromStreams([
      createListStream(['a', 'b', 'c', 'c']),
      createUniqStream(),
      createConcatStream([]),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  test('removes duplicate objects', async () => {
    const results = await createPromiseFromStreams([
      createListStream([
        { type: 'dashboard', id: '123', foo: 'bar' },
        { type: 'visualization', id: '123', foo: 'bar' },
        { type: 'visualization', id: '123', bar: 'foo' },
        { id: '123', type: 'visualization' }
      ]),
      createUniqStream(value => JSON.stringify(pick(value, 'id', 'type'))),
      createConcatStream([])
    ]);
    expect(results).toEqual([
      { type: 'dashboard', id: '123', foo: 'bar' },
      { type: 'visualization', id: '123', foo: 'bar' }
    ]);
  });

  test('errors out when iteratee returns an object', async () => {
    try {
      await createPromiseFromStreams([
        createListStream([
          { type: 'dashboard', id: '123' }
        ]),
        createUniqStream(),
        createConcatStream([])
      ]);
      throw new Error('Should have failed');
    } catch (e) {
      expect(e.message).toBe('Iteratee cannot be an object');
    }
  });
});
