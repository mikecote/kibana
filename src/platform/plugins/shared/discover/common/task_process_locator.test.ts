/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { DISCOVER_APP_LOCATOR } from './app_locator';
import { createDiscoverAppLocatorDefinition } from './task_process_locator';

describe('createDiscoverAppLocatorDefinition', () => {
  it('is the Discover locator, which builds a path to Discover', async () => {
    const definition = createDiscoverAppLocatorDefinition();
    expect(definition.id).toBe(DISCOVER_APP_LOCATOR);

    const location = await definition.getLocation({
      indexPatternId: 'logs',
      query: { query: 'x', language: 'kuery' },
    });
    expect(location.app).toBe('discover');
    expect(location.path).toContain('dataViewId:logs');
  });
});
