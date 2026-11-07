/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import type { Observable } from 'rxjs';
import type { ILicense } from '@kbn/licensing-types';
import { License } from '@kbn/licensing-plugin/common/license';
import { coreMock } from '@kbn/core/server/mocks';
import { createIndexPatternsStartMock } from '@kbn/data-views-plugin/server/mocks';
import { createTaskHostMock } from '@kbn/task-manager-plugin/server/task_type_module.mocks';
import { createStandaloneFieldFormats } from '@kbn/alerting-plugin/server/task_types/standalone/field_formats';
import type {
  createMlTaskProcessServices,
  MlTaskProcessSettings,
} from './ml_task_process_services';

export const createMlRuleLicense = (): ILicense =>
  new License({
    license: {
      uid: 'ml-rule-license',
      type: 'platinum',
      mode: 'platinum',
      status: 'active',
      expiryDateInMillis: Date.now() + 86_400_000,
    },
    features: { ml: { isAvailable: true, isEnabled: true } },
    signature: 'signature',
  });

export const createMlRuleSettings = (): MlTaskProcessSettings => ({
  enabledFeatures: { ad: true, dfa: false, nlp: false },
  compatibleModuleType: 'security',
  spacesEnabled: false,
  cpsEnabled: true,
  moduleFiles: { 'native_module/manifest.json': '{"id":"native_module"}' },
  cloud: { cloudId: 'native-cloud-id', baseUrl: 'https://cloud.example.test', isInTrial: true },
});

export const createMlRuleServicesDeps = (
  license$: Observable<ILicense> = of(createMlRuleLicense())
): Parameters<typeof createMlTaskProcessServices>[0] => {
  const core = coreMock.createStart();
  return {
    host: createTaskHostMock({
      security: { ...core.security, fips: coreMock.createSetup().security.fips },
      http: core.http,
      licensing: { license$ },
    }),
    runtime: { uiSettings: core.uiSettings, dataViews: createIndexPatternsStartMock() },
    fieldFormats: createStandaloneFieldFormats(),
    isServerless: false,
    settings: { ml: createMlRuleSettings() },
  };
};
