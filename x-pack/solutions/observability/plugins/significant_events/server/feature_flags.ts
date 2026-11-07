/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger } from '@kbn/core/server';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import { isObservabilityDeployment } from './routes/utils/assert_significant_events_access';
import { SIGNIFICANT_EVENTS_TIERED_FEATURE } from '../common';
import {
  getSignificantEventsUiSettings,
  getSignificantEventsGlobalUiSettings,
} from './get_ui_settings';

/** Registers significant events settings in eligible deployments and pricing tiers. */
export const registerFeatureFlags = (
  core: Pick<CoreSetup, 'pricing' | 'uiSettings'>,
  logger: Logger,
  cloud?: CloudSetup
): void => {
  if (!isObservabilityDeployment({ cloud })) return;
  core.pricing
    .isFeatureAvailable(SIGNIFICANT_EVENTS_TIERED_FEATURE.id)
    .then((available) => {
      if (!available) return;
      core.uiSettings.register(getSignificantEventsUiSettings());
      core.uiSettings.registerGlobal(getSignificantEventsGlobalUiSettings());
    })
    .catch((error) => {
      logger.error(`Failed to register significant events ui settings: ${error}`);
    });
};
