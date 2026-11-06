/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { UiSettingsParams } from '@kbn/core/server';
import { i18n } from '@kbn/i18n';
import {
  CONTEXT_ENGINE_ENABLED_SETTING_ID,
  CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID,
} from '@kbn/management-settings-ids';
import { CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID } from '../common/constants';

/**
 * The per-space switch every step and tool reads (registered by the Agent Builder SML plugin, whose
 * definition this mirrors for a task process: the default is what a space that never set it has).
 */
export const contextEngineEnabledSetting: UiSettingsParams<boolean> = {
  name: 'Context Engine',
  type: 'boolean',
  value: false,
  schema: schema.boolean(),
};

export const contextEngineSpaceUiSettings: Record<string, UiSettingsParams> = {
  [CONTEXT_ENGINE_ENABLED_SETTING_ID]: contextEngineEnabledSetting,
};

/** The global settings the plugin registers in its `setup()`, and a task process registers for its steps and tools. */
export const contextEngineGlobalUiSettings: Record<string, UiSettingsParams> = {
  [CONTEXT_ENGINE_FEEDBACK_LOOP_ENABLED_SETTING_ID]: {
    name: i18n.translate('xpack.contextEngine.uiSettings.feedbackLoop.name', {
      defaultMessage: 'Context Engine feedback loop',
    }),
    description: i18n.translate('xpack.contextEngine.uiSettings.feedbackLoop.description', {
      defaultMessage:
        'Generates classified signals from Agent Builder traces to power the Context Engine feedback loop.',
    }),
    schema: schema.boolean(),
    value: false,
    experimental: true,
    requiresPageReload: false,
    readonly: false,
  },
  [CONTEXT_ENGINE_MEMORY_ENABLED_SETTING_ID]: {
    name: i18n.translate('xpack.contextEngine.uiSettings.memory.name', {
      defaultMessage: 'Context Engine memory',
    }),
    description: i18n.translate('xpack.contextEngine.uiSettings.memory.description', {
      defaultMessage: 'Enables memory capabilities for Context Engine AI indices.',
    }),
    schema: schema.boolean(),
    value: false,
    experimental: true,
    requiresPageReload: false,
    readonly: false,
  },
};
