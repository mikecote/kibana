/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { SignificantEventsServer } from '../../types';
import type { SignificantEventsAvailabilityResponse } from '../../../common';
import {
  SIGNIFICANT_EVENTS_TIERED_FEATURE,
  type SignificantEventsUnavailableReason,
} from '../../../common';
import { isSignificantEventsFeatureFlagEnabled } from '../../lib/feature_flags/is_significant_events_feature_flag_enabled';
import { createSignificantEventsAccessChecker } from '../../run_services/create_access_checker';

interface SignificantEventsAccessContext {
  server: SignificantEventsServer;
  licensing: Pick<LicensingPluginStart, 'getLicense'>;
}

interface AssertSignificantEventsAccessParams extends SignificantEventsAccessContext {
  /** Requirements to skip, e.g. `feature_flag` so Pause stays reachable while Nightshift is off. */
  ignore?: readonly SignificantEventsUnavailableReason[];
}

/**
 * Observability serverless projects and classic deployments only. The pricing tier cannot express
 * this: `isFeatureAvailable` returns `true` wherever `pricing.tiers.enabled` is `false`, which is
 * every project type except Observability. Classic / non-cloud is allowed when
 * `cloud.isServerlessEnabled` is false or cloud is absent; serverless always lives in cloud, so
 * that boolean is authoritative for the classic vs serverless split.
 */
export const isObservabilityDeployment = ({
  cloud,
}: {
  cloud?: Pick<CloudSetup, 'isServerlessEnabled' | 'serverless'>;
}): boolean =>
  !cloud?.isServerlessEnabled ? true : cloud.serverless.projectType === 'observability';

const getAccessChecker = ({ server, licensing }: SignificantEventsAccessContext) =>
  createSignificantEventsAccessChecker({
    isFeatureEnabled: () => isSignificantEventsFeatureFlagEnabled(server.core.featureFlags),
    isDeploymentSupported: () => isObservabilityDeployment({ cloud: server.cloud }),
    isPricingTierAvailable: () =>
      server.core.pricing.isFeatureAvailable(SIGNIFICANT_EVENTS_TIERED_FEATURE.id),
    getLicense: () => licensing.getLicense(),
    hasPlugin: (plugin) => Boolean(server[plugin]),
  });

/** Asserts the shared significant events requirements using the native server services. */
export const assertSignificantEventsAccess = async ({
  ignore,
  ...context
}: AssertSignificantEventsAccessParams): Promise<void> =>
  getAccessChecker(context).assertAccess(ignore);

/** Checks significant events availability without a request. */
export const isSignificantEventsAvailable = async (
  context: SignificantEventsAccessContext
): Promise<boolean> => getAccessChecker(context).isAvailable();

/** Returns the first unmet significant events requirement for the availability endpoint. */
export const getSignificantEventsAvailability = async (
  context: SignificantEventsAccessContext
): Promise<SignificantEventsAvailabilityResponse> => getAccessChecker(context).getAvailability();
