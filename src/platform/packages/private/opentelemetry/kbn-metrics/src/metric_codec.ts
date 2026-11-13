/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { serialize, deserialize, Deserializer } from 'node:v8';
import type { ScopeMetrics } from '@opentelemetry/sdk-metrics';
import type { MetricResourceSnapshot } from './metric_collection';

const MAX_ENCODED_BYTES = 64 * 1024 * 1024;
const header = new Deserializer(serialize([]));
header.readHeader();
export const METRIC_SERIALIZATION_VERSION = header.getWireFormatVersion();

const decodeBuffer = (encoded: string): Buffer => {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > MAX_ENCODED_BYTES) {
    throw new Error('Native metric data exceeds the transport limit');
  }
  return Buffer.from(encoded, 'base64');
};

const encodeBuffer = (buffer: Buffer): string => {
  const encoded = buffer.toString('base64');
  if (Buffer.byteLength(encoded) > MAX_ENCODED_BYTES) {
    throw new Error('Native metric data exceeds the transport limit');
  }
  return encoded;
};

/** Encodes only native aggregate data while retaining IEEE floating-point values and attribute types. */
export const encodeMetricScopes = (scopes: readonly ScopeMetrics[]): string =>
  encodeBuffer(serialize(scopes));

/** Restores aggregate data produced by the negotiated native metric serializer. */
export const decodeMetricScopes = (encoded: string): ScopeMetrics[] => {
  const scopes: ScopeMetrics[] = deserialize(decodeBuffer(encoded));
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope?.scope?.name === 'string' && Array.isArray(scope.metrics))
  ) {
    throw new Error('Invalid native metric collection');
  }
  return scopes;
};

/** Encodes live gauge resources without serializing SDK clients or resource implementations. */
export const encodeMetricResources = (resources: readonly MetricResourceSnapshot[]): string =>
  encodeBuffer(serialize(resources));

/** Restores primitive resource attributes and native gauge aggregate data. */
export const decodeMetricResources = (encoded: string): MetricResourceSnapshot[] => {
  const resources: MetricResourceSnapshot[] = deserialize(decodeBuffer(encoded));
  if (
    !Array.isArray(resources) ||
    !resources.every(
      (resource) => resource?.resourceAttributes && Array.isArray(resource.scopeMetrics)
    )
  ) {
    throw new Error('Invalid native metric resources');
  }
  return resources;
};
