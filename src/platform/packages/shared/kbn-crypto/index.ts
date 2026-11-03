/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import type * as Pkcs12 from './src/pkcs12';

export type { Pkcs12ReadResult } from './src/pkcs12';

// `node-forge` is large and only needed when a PKCS#12 file is configured, so it loads on first use.
const loadPkcs12 = (): typeof Pkcs12 => require('./src/pkcs12');

export const readPkcs12Keystore: typeof Pkcs12.readPkcs12Keystore = (...args) =>
  loadPkcs12().readPkcs12Keystore(...args);
export const readPkcs12Truststore: typeof Pkcs12.readPkcs12Truststore = (...args) =>
  loadPkcs12().readPkcs12Truststore(...args);
export { createSHA256Hash } from './src/sha256';
