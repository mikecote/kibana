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

import { createListStream } from './list_stream';
import { createMergeAllStream } from './merge_all_stream';

function createFailingReadableStream() {
  return new Readable({
    objectMode: true,
    read() {
      this.emit('error', new Error('Test error'));
    }
  });
}

describe('createMergeAllStream()', () => {
  test('merges streams together', async () => {
    const readStream = new Readable({ objectMode: true });
    const mergeAllStream = createMergeAllStream();
    const onData = jest.fn();

    readStream
      .pipe(mergeAllStream)
      .on('data', onData);

    readStream.push(createListStream([1, 2, 3]));
    readStream.push(createListStream([4, 5]));
    readStream.push(null);

    await new Promise(resolve => mergeAllStream.on('finish', resolve));

    expect(onData).toHaveBeenCalledTimes(5);
  });

  test('handles errors when given stream fails', async () => {
    const readStream = new Readable({ objectMode: true });
    const mergeAllStream = createMergeAllStream();
    const onError = jest.fn();

    readStream
      .pipe(mergeAllStream)
      .on('error', onError);

    readStream.push(createFailingReadableStream());
    readStream.push(null);

    await new Promise(resolve => mergeAllStream.on('error', resolve));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('Test error');
  });
});
