/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import { uiSettings } from '../ui_settings';

export const OBSERVABILITY_UI_SETTINGS_ID = 'observabilityUiSettingsRuntime';
export const contribution: WorkflowStepsContribution = {
  declares: {
    settings: [OBSERVABILITY_UI_SETTINGS_ID],
    registerUiSettings: (registry, settings) => {
      if (settings[OBSERVABILITY_UI_SETTINGS_ID]) registry.register(uiSettings);
    },
  },
  register: () => {},
};
