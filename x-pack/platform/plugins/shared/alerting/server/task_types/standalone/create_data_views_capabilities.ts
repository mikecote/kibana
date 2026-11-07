/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { merge } from 'lodash';
import type { Logger } from '@kbn/core/server';
import { getDataViewsDefaultCapabilities } from '@kbn/data-views-plugin/server';
import type { DataViewsCapabilities } from '@kbn/data-views-plugin/server';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import { KibanaFeature, uiCapabilitiesForFeatures } from '@kbn/features-plugin/server';
import { createSecurityCapabilitiesSwitcher } from '@kbn/security-plugin/server';
import { createSpacesCapabilitiesSwitcher } from '@kbn/spaces-plugin/server';

interface DataViewsCapabilitiesServices {
  features: readonly KibanaFeatureConfig[];
  authz: Parameters<typeof createSecurityCapabilitiesSwitcher>[0]['authz'];
  getCurrentUser: Parameters<typeof createSecurityCapabilitiesSwitcher>[0]['getCurrentUser'];
  getActiveSpace?: Parameters<typeof createSpacesCapabilitiesSwitcher>[0]['getActiveSpace'];
  logger: Logger;
}

/** Resolves data-view write capabilities through the native Security and Spaces switchers. */
export const createDataViewsCapabilities = ({
  features,
  authz,
  getCurrentUser,
  getActiveSpace,
  logger,
}: DataViewsCapabilitiesServices): DataViewsCapabilities => {
  const definitions = features.map((feature) => new KibanaFeature(feature));
  const defaults = merge(
    { navLinks: {}, management: {}, catalogue: {} },
    uiCapabilitiesForFeatures(definitions, []),
    getDataViewsDefaultCapabilities()
  );
  const security = createSecurityCapabilitiesSwitcher({
    authz,
    getCurrentUser,
    getKibanaFeatures: () => definitions,
    getElasticsearchFeatures: () => [],
    logger,
  });
  const spaces = getActiveSpace
    ? createSpacesCapabilitiesSwitcher({
        getActiveSpace,
        getKibanaFeatures: async () => definitions,
        logger,
      })
    : undefined;
  return {
    resolveCapabilities: async (request) => {
      const secured = merge({}, defaults, await security(request, defaults, false));
      const scoped = spaces ? merge({}, secured, await spaces(request, secured, false)) : secured;
      return scoped;
    },
  };
};
