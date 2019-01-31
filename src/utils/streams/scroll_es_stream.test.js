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
    const mockCallCluster = jest.fn();
    mockCallCluster.mockResolvedValueOnce({
      _scroll_id: 'abc',
      hits: {
        total: 0,
        hits: [],
      },
    });
    const results = await createPromiseFromStreams([
      createScrollEsStream(mockCallCluster),
      createConcatStream([]),
    ]);
    expect(results).toHaveLength(0);
    expect(mockCallCluster).toHaveBeenCalledTimes(2);
    expect(mockCallCluster.mock.calls[0]).toEqual(['search', {
      _source: true,
      rest_total_hits_as_int: true,
      scroll: '1m',
      size: 300,
    }]);
    expect(mockCallCluster.mock.calls[1]).toEqual(['clearScroll', {
      scrollId: 'abc',
    }]);
  });

  test('scrolls through Elasticsearch with results', async () => {
    const typeValue = 'my_type';
    const indexName = 'my_index';
    const mockCallCluster = jest.fn();
    mockCallCluster.mockResolvedValueOnce({
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

    const results = await createPromiseFromStreams([
      createScrollEsStream(mockCallCluster),
      createConcatStream([]),
    ]);

    expect(results).toHaveLength(1);
    expect(mockCallCluster).toHaveBeenCalledTimes(2);
    expect(mockCallCluster.mock.calls[0]).toEqual(['search', {
      _source: true,
      rest_total_hits_as_int: true,
      scroll: '1m',
      size: 300,
    }]);
    expect(mockCallCluster.mock.calls[1]).toEqual(['clearScroll', {
      scrollId: 'abc',
    }]);
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
    const mockCallCluster = jest.fn();
    mockCallCluster.mockRejectedValueOnce(new Error('Test error'));
    try {
      await createPromiseFromStreams([
        createScrollEsStream(mockCallCluster),
        createConcatStream([]),
      ]);
      throw new Error('Should have failed');
    } catch (e) {
      expect(e.message).toBe('Test error');
      // No scroll id assigned, so clearScroll won't get called
      expect(mockCallCluster).toHaveBeenCalledTimes(1);
      expect(mockCallCluster.mock.calls[0]).toEqual(['search', {
        _source: true,
        rest_total_hits_as_int: true,
        scroll: '1m',
        size: 300,
      }]);
    }
  });

  test('stream clears scroll when destroy is called', async () => {
    const typeValue = 'my_type';
    const indexName = 'my_index';
    const mockCallCluster = jest.fn();
    mockCallCluster.mockResolvedValueOnce({
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
    mockCallCluster.mockResolvedValueOnce({
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
    try {
      await createPromiseFromStreams([
        createScrollEsStream(mockCallCluster),
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
      expect(mockCallCluster).toHaveBeenCalledTimes(3);
      expect(mockCallCluster.mock.calls[0]).toEqual(['search', {
        _source: true,
        rest_total_hits_as_int: true,
        scroll: '1m',
        size: 300,
      }]);
      expect(mockCallCluster.mock.calls[1]).toEqual(['clearScroll', {
        scrollId: 'abc',
      }]);
      // TODO: Why scroll called after clearScroll?
      expect(mockCallCluster.mock.calls[2]).toEqual(['scroll', {
        scroll: '1m',
        scrollId: 'abc',
      }]);
    }
  });
});
