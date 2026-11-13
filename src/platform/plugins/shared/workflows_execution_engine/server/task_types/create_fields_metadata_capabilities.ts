/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { merge } from 'lodash';
import type { KibanaRequest, Logger } from '@kbn/core/server';
import type { KibanaFeatureConfig } from '@kbn/features-plugin/common';
import { KibanaFeature, uiCapabilitiesForFeatures } from '@kbn/features-plugin/server';
import type { FieldsMetadataCapabilities } from '@kbn/fields-metadata-plugin/server';
import { createSecurityCapabilitiesSwitcher } from '@kbn/security-plugin/server';
import { createSpacesCapabilitiesSwitcher } from '@kbn/spaces-plugin/server';

interface FieldsMetadataCapabilitiesServices {
  features: readonly KibanaFeatureConfig[];
  authz: Parameters<typeof createSecurityCapabilitiesSwitcher>[0]['authz'];
  getCurrentUser: Parameters<typeof createSecurityCapabilitiesSwitcher>[0]['getCurrentUser'];
  getActiveSpace: Parameters<typeof createSpacesCapabilitiesSwitcher>[0]['getActiveSpace'];
  logger: Logger;
}

/** Resolves Fleet's metadata capabilities using the shared security and space gates. */
export const createFieldsMetadataCapabilities = ({
  features,
  authz,
  getCurrentUser,
  getActiveSpace,
  logger,
}: FieldsMetadataCapabilitiesServices): ((
  request: KibanaRequest
) => Promise<FieldsMetadataCapabilities>) => {
  const definitions = features.map((feature) => new KibanaFeature(feature));
  const fleetFeatures = definitions.filter(
    (feature) => !feature.deprecated && (feature.id === 'fleet' || feature.id === 'fleetv2')
  );
  const defaults = merge(
    { navLinks: {}, management: {}, catalogue: {} },
    uiCapabilitiesForFeatures(fleetFeatures, [])
  );
  const security = createSecurityCapabilitiesSwitcher({
    authz,
    getCurrentUser,
    getKibanaFeatures: () => fleetFeatures,
    getElasticsearchFeatures: () => [],
    logger,
  });
  const spaces = createSpacesCapabilitiesSwitcher({
    getActiveSpace,
    getKibanaFeatures: async () => definitions,
    logger,
  });
  return async (request) => {
    if (fleetFeatures.length === 0) return { fleet: undefined, fleetv2: undefined };
    const secured = merge({}, defaults, await security(request, defaults, false));
    const scoped = merge({}, secured, await spaces(request, secured, false));
    const { fleet, fleetv2 } = scoped;
    return { fleet, fleetv2 };
  };
};
