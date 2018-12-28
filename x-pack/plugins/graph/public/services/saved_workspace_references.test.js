/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { extractReferences, injectReferences } from './saved_workspace_references';

describe('extractReferences', () => {
  test('extracts references from wsState', () => {
    const doc = {
      id: '1',
      attributes: {
        foo: true,
        wsState: JSON.stringify(
          JSON.stringify({
            indexPattern: 'pattern*',
            bar: true,
          })
        ),
      },
    };
    const updatedDoc = extractReferences(doc);
    expect(updatedDoc).toMatchInlineSnapshot(`
Object {
  "attributes": Object {
    "foo": true,
    "wsState": "\\"{\\\\\\"bar\\\\\\":true,\\\\\\"indexPatternRef\\\\\\":\\\\\\"indexPattern_0\\\\\\"}\\"",
  },
  "references": Array [
    Object {
      "id": "pattern*",
      "name": "indexPattern_0",
      "type": "index-pattern",
    },
  ],
}
`);
  });
});

describe('injectReferences', () => {
  test('injects references into context', () => {
    const context = {
      id: '1',
      foo: true,
      wsState: JSON.stringify({
        indexPatternRef: 'indexPattern_0',
        bar: true,
      }),
    };
    const references = [
      {
        name: 'indexPattern_0',
        type: 'index-pattern',
        id: 'pattern*',
      },
    ];
    injectReferences.call(context, references);
    expect(context).toMatchInlineSnapshot(`
Object {
  "foo": true,
  "id": "1",
  "wsState": "{\\"bar\\":true,\\"indexPattern\\":\\"pattern*\\"}",
}
`);
  });
});
