/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createMlRunServices } from '../ml_run_services';
import { createMlTaskProcessServices } from './ml_task_process_services';
import { createMlRuleServicesDeps } from './ml_task_process_services.test_helpers';

jest.mock('../ml_run_services', () => ({ createMlRunServices: jest.fn(() => ({})) }));

describe('createMlTaskProcessServices settings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the enabled features and module type of Kibana', () => {
    createMlTaskProcessServices(createMlRuleServicesDeps());
    expect(createMlRunServices).toHaveBeenCalledWith(
      expect.objectContaining({
        enabledFeatures: { ad: true, dfa: false, nlp: false },
        compatibleModuleType: 'security',
        serverless: { isServerless: false, cpsEnabled: true },
      })
    );
  });

  it('rejects missing settings instead of enabling every feature', () => {
    expect(() =>
      createMlTaskProcessServices({ ...createMlRuleServicesDeps(), settings: {} })
    ).toThrow('ML rule execution requires its dispatch settings');
    expect(createMlRunServices).not.toHaveBeenCalled();
  });

  it('uses captured Cloud facts and portable module assets', async () => {
    createMlTaskProcessServices(createMlRuleServicesDeps());
    const deps = jest.mocked(createMlRunServices).mock.calls[0]?.[0];
    if (!deps) throw new Error('The native ML service factory was not called');
    expect(deps.cloud.cloudId).toBe('native-cloud-id');
    expect(deps.cloud.baseUrl).toBe('https://cloud.example.test');
    expect(deps.cloud.isInTrial()).toBe(true);
    await expect(deps.moduleFiles?.read('native_module/manifest.json')).resolves.toBe(
      '{"id":"native_module"}'
    );
    await expect(deps.moduleFiles?.read('missing/manifest.json')).rejects.toThrow(
      'ML module asset was not dispatched'
    );
  });
});
