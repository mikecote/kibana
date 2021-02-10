/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import {
  countMappedFields,
  validateAlertTypeParamMappings,
} from './validate_alert_type_param_mappings';

test('should correctly count simple mapping', () => {
  const count = countMappedFields({
    properties: {
      a: {
        type: 'keyword',
      },
      b: {
        type: 'boolean',
      },
      c: {
        type: 'date',
      },
    },
  });
  expect(count).toEqual(3);
});

test('should not count fields that are not enabled', () => {
  const count = countMappedFields({
    properties: {
      a: {
        type: 'keyword',
      },
      b: {
        type: 'date',
      },
      c: {
        type: 'object',
        enabled: false,
      },
    },
  });
  expect(count).toEqual(2);
});

test('should not count fields that are not enabled even if properties are defined', () => {
  const count = countMappedFields({
    properties: {
      a: {
        type: 'keyword',
      },
      b: {
        type: 'date',
      },
      c: {
        type: 'object',
        enabled: false,
        properties: {
          cheese: {
            type: 'keyword',
          },
          pepperoni: {
            type: 'text',
          },
          pizza: {
            type: 'boolean',
          },
        },
      },
    },
  });
  expect(count).toEqual(2);
});

test('should correctly count multi-fields', () => {
  const count = countMappedFields({
    properties: {
      a: {
        type: 'keyword',
      },
      b: {
        type: 'date',
      },
      c: {
        type: 'text',
        fields: {
          raw: {
            type: 'keyword',
          },
          another: {
            type: 'custom_analyzer',
          },
        },
      },
    },
  });
  expect(count).toEqual(5);
});

test('should correctly count nested mappings', () => {
  const count = countMappedFields({
    properties: {
      a: {
        properties: {
          cheese: {
            type: 'keyword',
          },
          pepperoni: {
            type: 'text',
          },
          pizza: {
            type: 'boolean',
          },
        },
      },
      b: {
        type: 'date',
      },
      c: {
        type: 'text',
        fields: {
          raw: {
            type: 'keyword',
          },
          another: {
            type: 'custom_analyzer',
          },
        },
      },
    },
  });
  expect(count).toEqual(7);
});

test('should validate mappings with fewer than max allowed fields', () => {
  const count = validateAlertTypeParamMappings('testAlertId', {
    properties: {
      a: {
        properties: {
          cheese: {
            type: 'keyword',
          },
          pepperoni: {
            type: 'text',
          },
          pizza: {
            type: 'boolean',
          },
        },
      },
      b: {
        type: 'date',
      },
      c: {
        type: 'text',
        fields: {
          raw: {
            type: 'keyword',
          },
          another: {
            type: 'custom_analyzer',
          },
        },
      },
    },
  });
  expect(count).toEqual(7);
});

test('should throw error when mappings exceeds max allowed fields', () => {
  expect(() =>
    validateAlertTypeParamMappings('testAlertId', {
      properties: {
        a: {
          properties: {
            cheese: {
              type: 'keyword',
            },
            pepperoni: {
              type: 'text',
            },
            pizza: {
              type: 'boolean',
            },
          },
        },
        b: {
          type: 'date',
        },
        c: {
          type: 'text',
          fields: {
            raw: {
              type: 'keyword',
            },
            another: {
              type: 'custom_analyzer',
            },
          },
        },
        d: {
          type: 'boolean',
        },
        e: {
          properties: {
            hello: {
              type: 'text',
            },
            world: {
              type: 'date',
            },
          },
        },
        f: {
          type: 'keyword',
        },
      },
    })
  ).toThrowErrorMatchingInlineSnapshot(
    '"Alert type \\"testAlertId\\" has 11 mapped fields, which exceeds the max value of 10."'
  );
});
