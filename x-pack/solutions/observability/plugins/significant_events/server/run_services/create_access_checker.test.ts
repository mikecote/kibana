/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { licenseMock } from '@kbn/licensing-plugin/common/licensing.mock';
import { FeatureNotEnabledError } from '../lib/errors/feature_not_enabled_error';
import { MissingDependencyError } from '../lib/errors/missing_dependency_error';
import { createSignificantEventsAccessChecker } from './create_access_checker';

const enterprise = () =>
  licenseMock.createLicense({
    license: { type: 'enterprise', mode: 'enterprise', expiryDateInMillis: Date.now() + 86400000 },
  });

const create = () => {
  const services = {
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    isDeploymentSupported: jest.fn().mockReturnValue(true),
    isPricingTierAvailable: jest.fn().mockReturnValue(true),
    getLicense: jest.fn().mockResolvedValue(enterprise()),
    hasPlugin: jest.fn().mockReturnValue(true),
  };
  return { services, checker: createSignificantEventsAccessChecker(services) };
};

describe('significant events execution access', () => {
  it('rechecks licensing without retaining a previous successful decision', async () => {
    const { services, checker } = create();
    await expect(checker.isAvailable()).resolves.toBe(true);
    services.getLicense.mockResolvedValueOnce(licenseMock.createLicense());
    await expect(checker.getAvailability()).resolves.toEqual({
      available: false,
      reason: 'license',
    });
    await expect(checker.isAvailable()).resolves.toBe(true);
    expect(services.getLicense).toHaveBeenCalledTimes(3);
  });

  it('preserves gate order and the native error types when several requirements fail', async () => {
    const { services, checker } = create();
    services.isFeatureEnabled.mockResolvedValue(false);
    services.isDeploymentSupported.mockReturnValue(false);
    services.isPricingTierAvailable.mockReturnValue(false);
    services.getLicense.mockResolvedValue(licenseMock.createLicense());
    services.hasPlugin.mockReturnValue(false);
    await expect(checker.getAvailability()).resolves.toEqual({
      available: false,
      reason: 'feature_flag',
    });
    await expect(checker.assertAccess()).rejects.toBeInstanceOf(FeatureNotEnabledError);
    await expect(
      checker.assertAccess(['feature_flag', 'project_type', 'pricing_tier'])
    ).rejects.toThrow('An Enterprise license');
    await expect(
      checker.assertAccess(['feature_flag', 'project_type', 'pricing_tier', 'license'])
    ).rejects.toBeInstanceOf(MissingDependencyError);
  });

  it('omits an ignored gate while preserving the remaining requirements', async () => {
    const { services, checker } = create();
    await expect(checker.assertAccess(['feature_flag'])).resolves.toBeUndefined();
    expect(services.isFeatureEnabled).not.toHaveBeenCalled();
    expect(services.getLicense).toHaveBeenCalledTimes(1);
    expect(services.hasPlugin).toHaveBeenCalledTimes(3);
  });

  it('propagates a failed service read rather than converting it to an availability decision', async () => {
    const { services, checker } = create();
    const error = new Error('License read failed');
    services.getLicense.mockRejectedValue(error);
    await expect(checker.getAvailability()).rejects.toBe(error);
  });
});
