/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

/**
 * Key of the global symbol exposing the current execution context to an inspector session, e.g.
 * the event loop watchdog's `Runtime.evaluate`. A worker thread runs in its own realm and cannot
 * import a `Symbol` object from the main thread, so the main thread and the worker instead agree
 * on this key and each call `Symbol.for(EXECUTION_CONTEXT_INSPECTOR_ACCESSOR_KEY)` themselves.
 *
 * `ExecutionContextService` installs the accessor only while something needs it (e.g. the
 * watchdog worker is running); it is not present on `globalThis` otherwise.
 */
export const EXECUTION_CONTEXT_INSPECTOR_ACCESSOR_KEY = 'kbn.core.executionContext';
