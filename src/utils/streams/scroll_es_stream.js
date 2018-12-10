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

import { assign } from 'lodash';
import { Readable } from 'stream';

const SCROLL_SIZE = 100;
const SCROLL_TIMEOUT = '1m';

export function createScrollESStream(client, args) {
  let pointer = 0;
  let isReading = false;
  let fetchAfter = false;
  let scrollId = null;

  const readableStream = new Readable({
    objectMode: true,
    read() {
      readPage();
    }
  });

  /**
   * Push hits down the stream and handle back pressure.
   *
   * @param {Array} hits List of Elasticsearch hits to push down the stream.
   */
  async function pushHits(hits) {
    for (const hit of hits) {
      pointer += 1;
      // TODO: Change structure
      const continuePushing = readableStream.push({
        type: 'doc',
        value: {
          index: hit._index,
          type: hit._type,
          id: hit._id,
          source: hit._source,
        },
      });
      if (!continuePushing) {
        await new Promise((resolve) => {
          // TODO: What about reject?
          // TODO: Check if drained yet (async code executed between await and here)
          readableStream._readableState.pipes.once('drain', resolve);
        });
      }
    }
  }

  /**
   * Read a given range from Elasticsearch and push down the stream
   */
  async function readPage() {
    try {
      if (isReading) {
        fetchAfter = true;
        return;
      }
      isReading = true;
      let resp;
      // Fetch page from Elasticsearch
      if (scrollId) {
        resp = await client.scroll({
          size: SCROLL_SIZE,
          scrollId: scrollId,
          scroll: SCROLL_TIMEOUT,
        });
      } else {
        args = assign({}, args, {
          scroll: SCROLL_TIMEOUT,
          _source: true,
          rest_total_hits_as_int: true,
        });
        resp = await client.search(args);
      }
      scrollId = resp._scroll_id;
      await pushHits(resp.hits.hits);
      isReading = false;
      if (resp.hits.total <= pointer) {
        readableStream.push(null);
      } else if (fetchAfter) {
        readPage();
      }
    } catch(e) {
      readableStream.emit('error', e);
    }
  }

  return readableStream;
}
