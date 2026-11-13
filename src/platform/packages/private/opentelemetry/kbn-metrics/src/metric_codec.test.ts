/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { ValueType } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType } from '@opentelemetry/sdk-metrics';
import type { ScopeMetrics } from '@opentelemetry/sdk-metrics';
import {
  encodeMetricScopes,
  decodeMetricScopes,
  encodeMetricResources,
  decodeMetricResources,
} from './metric_codec';

it('preserves native non-finite measurements and attribute value types through JSON envelopes', () => {
  const scopes: ScopeMetrics[] = [
    {
      scope: { name: 'kibana.test' },
      metrics: [
        {
          descriptor: {
            name: 'kibana.test.gauge',
            description: 'Native IEEE value fixture',
            unit: '1',
            valueType: ValueType.DOUBLE,
          },
          aggregationTemporality: AggregationTemporality.CUMULATIVE,
          dataPointType: DataPointType.GAUGE,
          dataPoints: [NaN, Infinity, -Infinity].map((value) => ({
            startTime: [0, 0],
            endTime: [1, 0],
            attributes: { native: value, text: String(value), values: [value] },
            value,
          })),
        },
      ],
    },
  ];
  const body: { encoded: string } = JSON.parse(
    JSON.stringify({ encoded: encodeMetricScopes(scopes) })
  );
  expect(decodeMetricScopes(body.encoded)).toEqual(scopes);
  const resources = [
    {
      resourceAttributes: { 'service.instance.id': 'worker', value: Infinity },
      scopeMetrics: scopes,
    },
  ];
  expect(decodeMetricResources(encodeMetricResources(resources))).toEqual(resources);
});

it('rejects malformed native metric payloads', () => {
  expect(() => decodeMetricScopes('invalid')).toThrow();
  expect(() => decodeMetricResources('invalid')).toThrow();
});
