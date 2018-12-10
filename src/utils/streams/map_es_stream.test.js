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
  createMapESStream,
  createListStream,
} from './';

describe('createMapESStream()', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      search: jest.fn(() => {
        return Promise.resolve({
          hits: {
            total: 0,
            hits: [],
          },
        });
      }),
    };
  });

  test('provides readable streams from inputs', async () => {
    const readStream = createListStream([{ index: 'my_index' }]);
    const mapStream = createMapESStream(mockClient);
    const onData = jest.fn();

    readStream
      .pipe(mapStream)
      .on('data', onData);

    await new Promise(resolve => mapStream.on('finish', resolve));

    expect(onData).toHaveBeenCalledTimes(1);
  });

  test('readable streams query Elasticsearch', async () => {
    const readStream = createListStream([{ index: 'my_index' }]);
    const mapStream = createMapESStream(mockClient);
    const onData = jest.fn();

    readStream
      .pipe(mapStream)
      .on('data', onData);

    await new Promise(resolve => mapStream.on('finish', resolve));

    expect(onData).toHaveBeenCalledTimes(1);

    const readableESStream = onData.mock.calls[0][0];
    const onESData = jest.fn();
    readableESStream.on('data', onESData);

    await new Promise(resolve => readableESStream.on('end', resolve));

    expect(mockClient.search).toHaveBeenCalledTimes(1);
    expect(onESData).toHaveBeenCalledTimes(0);
  });
});
