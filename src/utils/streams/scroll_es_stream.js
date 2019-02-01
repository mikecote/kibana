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

const SCROLL_SIZE = 300;
const SCROLL_TIMEOUT = '1m';

// Scroll stream
export function createScrollEsStream(callCluster, options = {}) {
  let pointer = 0;
  let isReading = false;
  let scrollId = null;

  const readableStream = new Readable({
    objectMode: true,
    read() {
      if (isReading) {
        return;
      }
      readPage();
    },
    async destroy(err, callback) {
      if (!scrollId) return callback();
      try {
        await callCluster('clearScroll', { scrollId });
        callback();
      } catch (err) {
        callback(err);
      }
    }
  });

  /**
   * Push hits down the stream and handle back pressure.
   *
   * @param {Array} hits List of Elasticsearch hits to push down the stream.
   */
  async function pushHits(hits) {
    for (const hit of hits) {
      const continuePushing = readableStream.push(hit);
      if (!continuePushing) {
        await new Promise((resolve) => {
          readableStream._readableState.pipes.once('drain', resolve);
        });
      }
    }
    pointer += hits.length;
  }

  /**
   * Read a given range from Elasticsearch and push down the stream
   */
  async function readPage() {
    try {
      isReading = true;
      let resp;
      // Fetch page from Elasticsearch
      if (scrollId) {
        resp = await callCluster('scroll', {
          scrollId: scrollId,
          scroll: SCROLL_TIMEOUT,
        });
      } else {
        resp = await callCluster('search', {
          ...options,
          scroll: SCROLL_TIMEOUT,
          size: SCROLL_SIZE,
          _source: true,
          rest_total_hits_as_int: true,
        });
      }
      scrollId = resp._scroll_id || scrollId;
      await pushHits(resp.hits.hits);
      isReading = false;
      if (resp.hits.total <= pointer) {
        readableStream.push(null);
        await callCluster('clearScroll', { scrollId });
        scrollId = null;
      }
    } catch(e) {
      readableStream.emit('error', e);
    }
  }

  return readableStream;
}
