/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ConfigSchema as spacesConfigSchema } from '@kbn/spaces-plugin/server/config';
import { captureModuleFiles } from '../../models/data_recognizer/module_files';
import type { MlTaskProcessSettings } from '../../task_types/ml_task_process_services';

export const getMlRuleTestSettings = async (): Promise<MlTaskProcessSettings> => ({
  enabledFeatures: { ad: true, dfa: true, nlp: true },
  compatibleModuleType: null,
  cpsEnabled: false,
  spacesEnabled: true,
  spaces: {
    config: spacesConfigSchema.validate({}, { offering: 'traditional' }),
    buildFlavor: 'traditional',
    features: [],
    cpsEnabled: false,
  },
  cloud: { isInTrial: false },
  moduleFiles: await captureModuleFiles(),
});
