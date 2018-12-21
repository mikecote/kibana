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
import { createScrollEsStream, createPromiseFromStreams, createConcatStream } from './';

describe('createScrollEsStream()', () => {
  test('scrolls through Elasticsearch when no results exist', async () => {
    const mockClient = {
      clearScroll: jest.fn((args, done) => done()),
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
    const results = await createPromiseFromStreams([
      createScrollEsStream(mockClient, { index: 'my_index' }),
      createConcatStream([]),
    ]);
    expect(results).toHaveLength(0);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(mockClient.clearScroll).toHaveBeenCalledTimes(1);
  });

  test('scrolls through Elasticsearch with results', async () => {
    const typeValue = 'my_type';
    const indexName = 'my_index';
    const mockClient = {
      search: jest.fn(() => {
        return Promise.resolve({
          _scroll_id: 'abc',
          hits: {
            total: 1,
            hits: [
              {
                _index: indexName,
                _type: typeValue,
                _id: '123',
                _source: {
                  attr: 'value',
                },
              },
            ],
          },
        });
      }),
      clearScroll: jest.fn((args, callback) => {
        callback();
      }),
    };

    const results = await createPromiseFromStreams([
      createScrollEsStream(mockClient, { index: indexName }),
      createConcatStream([]),
    ]);

    expect(results).toHaveLength(1);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(mockClient.clearScroll).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchInlineSnapshot(`
Object {
  "type": "doc",
  "value": Object {
    "id": "123",
    "index": "my_index",
    "source": Object {
      "attr": "value",
    },
    "type": "my_type",
  },
}
`);
  });

  test('handles errors when search fails', async () => {
    const mockClient = {
      search: jest.fn(() => {
        return Promise.reject(new Error('Test error'));
      }),
      clearScroll: jest.fn((args, callback) => {
        callback();
      }),
    };
    try {
      await createPromiseFromStreams([
        createScrollEsStream(mockClient, { index: 'my_index' }),
        createConcatStream([]),
      ]);
      throw new Error('Should have failed');
    } catch (e) {
      expect(e.message).toBe('Test error');
      // No scroll id assigned, so clearScroll won't get called
      expect(mockClient.clearScroll).toHaveBeenCalledTimes(0);
    }
  });

  test('stream clears scroll when destroy is called', async () => {
    const typeValue = 'my_type';
    const indexName = 'my_index';
    const mockClient = {
      search: jest.fn(() => {
        return Promise.resolve({
          _scroll_id: 'abc',
          hits: {
            total: 2,
            hits: [
              {
                _index: indexName,
                _type: typeValue,
                _id: '123',
                _source: {
                  attr: 'value',
                },
              },
            ],
          },
        });
      }),
      scroll: jest.fn(() => {
        return Promise.resolve({
          _scroll_id: 'abc',
          hits: {
            total: 2,
            hits: [
              {
                _index: indexName,
                _type: typeValue,
                _id: '456',
                _source: {
                  attr: 'value',
                },
              },
            ],
          },
        });
      }),
      clearScroll: jest.fn((args, callback) => {
        callback();
      }),
    };
    try {
      await createPromiseFromStreams([
        createScrollEsStream(mockClient, { index: 'my_index' }),
        new Transform({
          objectMode: true,
          transform(obj, enc, done) {
            done(new Error('Test error'));
          }
        }),
      ]);
      throw new Error('Should have failed');
    } catch (e) {
      expect(e.message).toBe('Test error');
      expect(mockClient.clearScroll).toHaveBeenCalledTimes(1);
    }
  });
});
