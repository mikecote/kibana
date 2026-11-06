/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createMlRunServices } from '../ml_run_services';
import { createMlTaskProcessServices } from './ml_task_process_services';

jest.mock('../ml_run_services', () => ({ createMlRunServices: jest.fn(() => ({})) }));

describe('createMlTaskProcessServices settings', () => {
  beforeEach(() => jest.clearAllMocks());

  const build = (mlSettings?: unknown) =>
    createMlTaskProcessServices({
      host: {},
      isServerless: false,
      settings: mlSettings ? { ml: mlSettings } : {},
    } as never);

  it('uses the enabled features and module type of Kibana', () => {
    build({
      cpsEnabled: true,
      enabledFeatures: { ad: true, dfa: false, nlp: false },
      compatibleModuleType: 'security',
    });
    expect(createMlRunServices).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledFeatures: { ad: true, dfa: false, nlp: false },
        compatibleModuleType: 'security',
        serverless: { isServerless: false, cpsEnabled: true },
      })
    );
  });

  it('falls back to every feature without settings', () => {
    build();
    expect(createMlRunServices).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledFeatures: { ad: true, dfa: true, nlp: true },
        compatibleModuleType: null,
      })
    );
  });
});
