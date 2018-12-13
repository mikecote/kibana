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

import {
  createScrollEsStream,
  createPromiseFromStreams,
  createConcatStream,
} from './';

describe('createScrollEsStream()', () => {
  test('scrolls through Elasticsearch when no results exist 2', async () => {
    const mockClient = {
      search: jest.fn(() => {
        return Promise.resolve({
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
  });

  test('scrolls through Elasticsearch with results', async () => {
    const typeValue = 'my_type';
    const indexName = 'my_index';
    const mockClient = {
      search: jest.fn(() => {
        return Promise.resolve({
          hits: {
            total: 1,
            hits: [{
              _index: indexName,
              _type: typeValue,
              _id: '123',
              _source: {
                attr: 'value',
              },
            }],
          },
        });
      }),
    };

    const results = await createPromiseFromStreams([
      createScrollEsStream(mockClient, { index: indexName }),
      createConcatStream([]),
    ]);

    expect(results).toHaveLength(1);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({
      type: 'doc',
      value: {
        index: indexName,
        type: typeValue,
        id: '123',
        source: {
          attr: 'value',
        },
      },
    });
  });

  test('handles errors when search fails', async () => {
    const mockClient = {
      search: jest.fn(() => {
        return Promise.reject(new Error('Test error'));
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
    }
  });
});
