/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { coreMock } from '@kbn/core/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import {
  OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED,
  OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_INTERVAL_HOURS,
  OBSERVABILITY_NIGHTSHIFT_DEVELOPER_MODE,
  OBSERVABILITY_STREAMS_SIGNIFICANT_EVENTS_TUNING_CONFIG,
  OBSERVABILITY_STREAMS_SIGNIFICANT_EVENTS_SCHEDULED_DISCOVERY_ENABLED,
} from '@kbn/management-settings-ids';
import { DEFAULT_SIGNIFICANT_EVENTS_TUNING_CONFIG } from '@kbn/significant-events-schema';
import { registerFeatureFlags } from './feature_flags';

describe('significant events UI settings registration', () => {
  it('registers discovery, developer and onboarding settings together with global tuning', async () => {
    const core = coreMock.createSetup();
    core.pricing.isFeatureAvailable.mockResolvedValue(true);
    registerFeatureFlags(core, loggerMock.create());
    await Promise.resolve();
    const settings = Object.assign(
      {},
      ...core.uiSettings.register.mock.calls.map(([value]) => value)
    );
    expect(settings).toEqual(
      expect.objectContaining({
        [OBSERVABILITY_STREAMS_SIGNIFICANT_EVENTS_SCHEDULED_DISCOVERY_ENABLED]:
          expect.objectContaining({ value: false }),
        [OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_ENABLED]: expect.objectContaining({
          value: false,
        }),
        [OBSERVABILITY_NIGHTSHIFT_CONTINUOUS_ONBOARDING_INTERVAL_HOURS]: expect.objectContaining({
          type: 'number',
        }),
        [OBSERVABILITY_NIGHTSHIFT_DEVELOPER_MODE]: expect.objectContaining({ value: false }),
      })
    );
    expect(core.uiSettings.registerGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        [OBSERVABILITY_STREAMS_SIGNIFICANT_EVENTS_TUNING_CONFIG]: expect.objectContaining({
          scope: 'global',
          value: JSON.stringify(DEFAULT_SIGNIFICANT_EVENTS_TUNING_CONFIG),
        }),
      })
    );
  });

  it('keeps the settings unregistered when the pricing tier is unavailable', async () => {
    const core = coreMock.createSetup();
    core.pricing.isFeatureAvailable.mockResolvedValue(false);
    registerFeatureFlags(core, loggerMock.create());
    await Promise.resolve();
    expect(core.uiSettings.register).not.toHaveBeenCalled();
    expect(core.uiSettings.registerGlobal).not.toHaveBeenCalled();
  });

  it('reports a failed pricing read without exposing the gated settings', async () => {
    const core = coreMock.createSetup();
    const logger = loggerMock.create();
    core.pricing.isFeatureAvailable.mockRejectedValue(new Error('Pricing unavailable'));
    registerFeatureFlags(core, logger);
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Pricing unavailable'));
    expect(core.uiSettings.register).not.toHaveBeenCalled();
    expect(core.uiSettings.registerGlobal).not.toHaveBeenCalled();
  });
});
