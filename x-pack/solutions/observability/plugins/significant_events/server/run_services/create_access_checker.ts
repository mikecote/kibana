/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import {
  SIGNIFICANT_EVENTS_REQUIRED_PLUGINS,
  type SignificantEventsAvailabilityResponse,
  type SignificantEventsRequiredPlugin,
  type SignificantEventsUnavailableReason,
} from '../../common';
import { FeatureNotEnabledError } from '../lib/errors/feature_not_enabled_error';
import { MissingDependencyError } from '../lib/errors/missing_dependency_error';

export interface SignificantEventsAccessServices {
  isFeatureEnabled: () => Promise<boolean>;
  isDeploymentSupported: () => boolean;
  isPricingTierAvailable: () => boolean;
  getLicense: LicensingPluginStart['getLicense'];
  hasPlugin: (plugin: SignificantEventsRequiredPlugin) => boolean;
}

export interface SignificantEventsAccessChecker {
  assertAccess: (ignore?: readonly SignificantEventsUnavailableReason[]) => Promise<void>;
  isAvailable: () => Promise<boolean>;
  getAvailability: () => Promise<SignificantEventsAvailabilityResponse>;
}

type RequirementCheck = (services: SignificantEventsAccessServices) => Promise<Error | undefined>;

const pluginRequirements = Object.fromEntries(
  SIGNIFICANT_EVENTS_REQUIRED_PLUGINS.map(
    (plugin): [SignificantEventsRequiredPlugin, RequirementCheck] => [
      plugin,
      async (services) =>
        services.hasPlugin(plugin)
          ? undefined
          : new MissingDependencyError(
              `Significant events requires the "${plugin}" plugin to be enabled first.`
            ),
    ]
  )
) as Record<SignificantEventsRequiredPlugin, RequirementCheck>;

const requirements: Record<SignificantEventsUnavailableReason, RequirementCheck> = {
  feature_flag: async (services) =>
    (await services.isFeatureEnabled())
      ? undefined
      : new FeatureNotEnabledError('Significant events is not available in this environment.'),
  project_type: async (services) =>
    services.isDeploymentSupported()
      ? undefined
      : new FeatureNotEnabledError(
          'Significant events is only available in Observability projects.'
        ),
  pricing_tier: async (services) =>
    services.isPricingTierAvailable()
      ? undefined
      : new FeatureNotEnabledError(
          'Significant events is not available on the current pricing tier.'
        ),
  license: async (services) =>
    (await services.getLicense()).hasAtLeast('enterprise')
      ? undefined
      : new FeatureNotEnabledError(
          'An Enterprise license or higher is required to use significant events.'
        ),
  ...pluginRequirements,
};

/** Evaluates significant events requirements using the services of the executing environment. */
export const createSignificantEventsAccessChecker = (
  services: SignificantEventsAccessServices
): SignificantEventsAccessChecker => {
  const findFirstUnmetRequirement = async (
    ignore: readonly SignificantEventsUnavailableReason[] = []
  ) => {
    const entries = (
      Object.entries(requirements) as Array<[SignificantEventsUnavailableReason, RequirementCheck]>
    ).filter(([reason]) => !ignore.includes(reason));
    // Evaluate in parallel while retaining declaration order for the first failure.
    const results = await Promise.all(
      entries.map(async ([reason, check]) => ({
        reason,
        error: await check(services),
      }))
    );
    for (const { reason, error } of results) {
      if (error) return { reason, error };
    }
    return undefined;
  };
  return {
    assertAccess: async (ignore) => {
      const unmet = await findFirstUnmetRequirement(ignore);
      if (unmet) throw unmet.error;
    },
    isAvailable: async () => (await findFirstUnmetRequirement()) === undefined,
    getAvailability: async () => {
      const unmet = await findFirstUnmetRequirement();
      return unmet ? { available: false, reason: unmet.reason } : { available: true };
    },
  };
};
