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

import sinon from 'sinon';
import { createExportRoute } from './export';
import { MockServer } from './_mock_server';

describe('POST /api/saved_objects/_export', () => {
  const savedObjectsClient = { find: sinon.stub().returns('') };
  let server;

  beforeEach(() => {
    server = new MockServer();

    const prereqs = {
      getSavedObjectsClient: {
        assign: 'savedObjectsClient',
        method() {
          return savedObjectsClient;
        }
      },
    };

    server.route(createExportRoute(prereqs));
  });

  afterEach(() => {
    savedObjectsClient.find.resetHistory();
  });

  it('formats successful response', async () => {
    const request = {
      method: 'POST',
      url: '/api/saved_objects/_export',
    };

    const clientResponse = {
      saved_objects: [
        {
          id: '123abc',
          type: 'some-type',
          attributes: {},
        },
      ]
    };

    const serverResponse = [
      {
        _id: '123abc',
        _type: 'some-type',
        _source: {},
      },
    ];

    savedObjectsClient.find.returns(Promise.resolve(clientResponse));

    const { payload, statusCode } = await server.inject(request);
    const response = JSON.parse(payload);

    expect(statusCode).toBe(200);
    expect(response).toEqual(serverResponse);
  });

  it('ability to filter specific types', async () => {
    const request = {
      method: 'POST',
      url: '/api/saved_objects/_export',
      payload: {
        type: 'some-type',
      },
    };

    const clientResponse = {
      saved_objects: [
        {
          id: '123abc',
          type: 'some-type',
          attributes: {},
        },
      ]
    };

    const serverResponse = [
      {
        _id: '123abc',
        _type: 'some-type',
        _source: {},
      },
    ];

    savedObjectsClient.find.returns(Promise.resolve(clientResponse));

    const { payload, statusCode } = await server.inject(request);
    const response = JSON.parse(payload);

    expect(statusCode).toBe(200);
    expect(response).toEqual(serverResponse);
  });
});
