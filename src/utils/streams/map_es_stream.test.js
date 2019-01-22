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

import {
  createMapEsStream,
  createListStream,
  createPromiseFromStreams,
  createConcatStream,
} from './';

function createFailingTransformStream() {
  return new Transform({
    objectMode: true,
    transform(obj, enc, done) {
      done(new Error('Test error'));
    }
  });
}

describe('createMapEsStream()', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      clearScroll: jest.fn((opts, done) => done()),
      search: jest.fn(() => {
        return Promise.resolve({
          _scroll_id: 'abc',
          hits: {
            total: 0,
            hits: [],
          },
        });
      }),
    };
  });

  test('provides readable streams from inputs', async () => {
    const readableStreams = await createPromiseFromStreams([
      createListStream([{ index: 'my_index' }]),
      createMapEsStream(mockClient),
      createConcatStream([]),
    ]);
    expect(readableStreams).toHaveLength(1);
  });

  test('readable streams query Elasticsearch', async () => {
    const readableStreams = await createPromiseFromStreams([
      createListStream([{ index: 'my_index' }]),
      createMapEsStream(mockClient),
      createConcatStream([]),
    ]);
    expect(readableStreams).toHaveLength(1);
    const readableEsStream = readableStreams[0];
    const searchResults = await createPromiseFromStreams([
      readableEsStream,
      createConcatStream([]),
    ]);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(searchResults).toHaveLength(0);
  });

  test('readable streams to destroy when main pipeline fails', async () => {
    const accumulatedStreams = [];
    try {
      await createPromiseFromStreams([
        createListStream([{ index: 'my_index' }]),
        createMapEsStream(mockClient),
        new Transform({
          objectMode: true,
          transform(obj, enc, done) {
            accumulatedStreams.push(obj);
            done(null, obj);
          }
        }),
        createFailingTransformStream(),
        createConcatStream([])
      ]);
      throw new Error('Should have failed');
    } catch (e) {
      expect(e).toHaveProperty('message', 'Test error');
      expect(accumulatedStreams).toHaveLength(1);
      expect(accumulatedStreams[0]).toHaveProperty('_readableState.destroyed', true);
    }
  });
});
