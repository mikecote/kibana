/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createRequire } from 'module';

declare const __KBN_VERSION__: string | undefined;

/**
 * Task bundles define `__KBN_VERSION__` at build time, so the repo info (which walks the file system
 * for the repo root) is only loaded when running from source.
 */
const getBuiltVersion = (): string =>
  typeof __KBN_VERSION__ !== 'undefined'
    ? __KBN_VERSION__
    : createRequire(__filename)('@kbn/repo-info').kibanaPackageJson.version;

/**
 * The Kibana version this pod runs as (`POD_KIBANA_VERSION` overrides it). Kibana sends its own
 * version with every run and the pod refuses a mismatch, since task state schemas and saved object
 * migrations are versioned with Kibana.
 */
export const POD_KIBANA_VERSION: string = process.env.POD_KIBANA_VERSION ?? getBuiltVersion();
