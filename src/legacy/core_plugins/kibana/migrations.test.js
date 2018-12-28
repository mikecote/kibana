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

import migrations from './migrations';

describe('search', () => {
  describe('7.0.0', () => {
    const migration = migrations.search['7.0.0'];

    test('throw error on empty object', () => {
      expect(() => migration({})).toThrowErrorMatchingInlineSnapshot(
        `"searchSourceJSON is missing on document \\"undefined\\""`
      );
    });

    test('throw error when searchSourceJSON is not a string', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: 123,
          },
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"searchSourceJSON is not a string on document \\"1\\""`
      );
    });

    test('throw error when searchSourceJSON is not valid JSON', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: '{123abc}',
          },
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"Failed to parse searchSourceJSON: \\"{123abc}\\" because \\"Unexpected number in JSON at position 1\\" on document \\"1\\""`
      );
    });

    test('throw error when "index" is missing from searchSourceJSON', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: '{"foo":true}',
          },
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"\\"index\\" attribute is missing within searchSourceJSON on document \\"1\\""`
      );
    });

    test('extract "index" attribute from doc', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: '{"index":"pattern*"}',
          },
        },
      };
      const migratedDoc = migration(doc);
      expect(migratedDoc).toMatchInlineSnapshot(`
Object {
  "attributes": Object {
    "kibanaSavedObjectMeta": Object {
      "searchSourceJSON": "{\\"indexRef\\":\\"indexPattern\\"}",
    },
  },
  "id": "1",
  "references": Array [
    Object {
      "id": "pattern*",
      "name": "indexPattern",
      "type": "index-pattern",
    },
  ],
}
`);
    });
  });
});

describe('visualization', () => {
  describe('7.0.0', () => {
    const migration = migrations.visualization['7.0.0'];

    test('throw error on empty object', () => {
      expect(() => migration({})).toThrowErrorMatchingInlineSnapshot(
        `"searchSourceJSON is missing on document \\"undefined\\""`
      );
    });

    test('throw error when searchSourceJSON is not a string', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: true,
          },
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"searchSourceJSON is not a string on document \\"1\\""`
      );
    });

    test('throw error when searchSourceJSON is not valid JSON', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: 'abc123',
          },
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"Failed to parse searchSourceJSON: \\"abc123\\" because \\"Unexpected token a in JSON at position 0\\" on document \\"1\\""`
      );
    });

    test('throw error when indexPattern and savedSearchId are missing', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: '{"foo":true}',
          },
        },
      };
      /* eslint-disable max-len */
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"At least one of the following attributes must be provided [\\"attributes.savedSearchId\\",\\"attributes.kibanaSavedObjectMeta.searchSourceJSON.index\\"] on document \\"1\\""`
      );
      /* eslint-enable max-len */
    });

    test('extract index reference from doc', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: '{"index":"123","foo":true}',
          },
        },
      };
      const migratedDoc = migration(doc);
      expect(migratedDoc).toMatchInlineSnapshot(`
Object {
  "attributes": Object {
    "kibanaSavedObjectMeta": Object {
      "searchSourceJSON": "{\\"foo\\":true,\\"indexRef\\":\\"indexPattern\\"}",
    },
  },
  "id": "1",
  "references": Array [
    Object {
      "id": "123",
      "name": "indexPattern",
      "type": "index-pattern",
    },
  ],
}
`);
    });

    test('extract saved search id from doc', () => {
      const doc = {
        id: '1',
        attributes: {
          kibanaSavedObjectMeta: {
            searchSourceJSON: '{}',
          },
          savedSearchId: '123',
        },
      };
      const migratedDoc = migration(doc);
      expect(migratedDoc).toMatchInlineSnapshot(`
Object {
  "attributes": Object {
    "kibanaSavedObjectMeta": Object {
      "searchSourceJSON": "{}",
    },
    "savedSearchRef": "search_0",
  },
  "id": "1",
  "references": Array [
    Object {
      "id": "123",
      "name": "search_0",
      "type": "search",
    },
  ],
}
`);
    });
  });
});

describe('dashboard', () => {
  describe('7.0.0', () => {
    const migration = migrations.dashboard['7.0.0'];

    test('throw error on empty object', () => {
      expect(() => migration({})).toThrowErrorMatchingInlineSnapshot(
        `"panelsJSON is missing on document \\"undefined\\""`
      );
    });

    test('throw error when panelsJSON is not a string', () => {
      const doc = {
        id: '1',
        attributes: {
          panelsJSON: 123,
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"panelsJSON is not a string on document \\"1\\""`
      );
    });

    test('throw error when panelsJSON is not valid JSON', () => {
      const doc = {
        id: '1',
        attributes: {
          panelsJSON: '{123abc}',
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"Failed to parse panelsJSON: \\"{123abc}\\" because \\"Unexpected number in JSON at position 1\\" on document \\"1\\""`
      );
    });

    test('throw error when a panel is missing "type" attribute', () => {
      const doc = {
        id: '1',
        attributes: {
          panelsJSON: '[{"id":"123"}]',
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"\\"type\\" attribute is missing from panel \\"0\\" on document \\"1\\""`
      );
    });

    test('throw error when a panel is missing "id" attribute', () => {
      const doc = {
        id: '1',
        attributes: {
          panelsJSON: '[{"type":"visualization"}]',
        },
      };
      expect(() => migration(doc)).toThrowErrorMatchingInlineSnapshot(
        `"\\"id\\" attribute is missing from panel \\"0\\" on document \\"1\\""`
      );
    });

    test('extract panel references from doc', () => {
      const doc = {
        id: '1',
        attributes: {
          panelsJSON:
            '[{"id":"1","type":"visualization","foo":true},{"id":"2","type":"visualization","bar":true}]',
        },
      };
      const migratedDoc = migration(doc);
      expect(migratedDoc).toMatchInlineSnapshot(`
Object {
  "attributes": Object {
    "panelsJSON": "[{\\"foo\\":true,\\"panelRef\\":\\"panel_0\\"},{\\"bar\\":true,\\"panelRef\\":\\"panel_1\\"}]",
  },
  "id": "1",
  "references": Array [
    Object {
      "id": "1",
      "name": "panel_0",
      "type": "visualization",
    },
    Object {
      "id": "2",
      "name": "panel_1",
      "type": "visualization",
    },
  ],
}
`);
    });
  });
});
