/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { cloneDeep } from 'lodash';
import type { Observable } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import type { CapabilitiesSwitcher, CoreSetup, Logger } from '@kbn/core/server';
import type { ILicense } from '@kbn/licensing-types';
import {
  type MlCapabilities,
  basicLicenseMlCapabilities,
  featureCapabilities,
} from '@kbn/ml-common-types/capabilities';
import type { MlFeatures } from '../../../common/constants/app';
import { isFullLicense, isMinimumLicense, isMlEnabled } from '../../../common/license';

export const setupCapabilitiesSwitcher = (
  coreSetup: CoreSetup,
  license$: Observable<ILicense>,
  enabledFeatures: MlFeatures,
  logger: Logger
) => {
  const switcher = createMlCapabilitiesSwitcher({
    license$,
    enabledFeatures,
    getIsServerless: async () => {
      const [coreStart] = await coreSetup.getStartServices();
      return coreStart.elasticsearch.getCapabilities().serverless;
    },
  });
  coreSetup.capabilities.registerSwitcher(
    async (request, capabilities, useDefaultCapabilities) => {
      try {
        return await switcher(request, capabilities, useDefaultCapabilities);
      } catch (error) {
        logger.debug(`Error updating capabilities for ML based on licensing: ${error}`);
        return {};
      }
    },
    {
      capabilityPath: 'ml.*',
    }
  );
};

/** Creates the native ML license and enabled-feature capability gate. */
export const createMlCapabilitiesSwitcher = ({
  license$,
  enabledFeatures,
  getIsServerless,
}: {
  license$: Observable<ILicense>;
  enabledFeatures: MlFeatures;
  getIsServerless: () => Promise<boolean>;
}): CapabilitiesSwitcher => {
  return async (request, capabilities) => {
    const isAnonymousRequest = !request.route.options.authRequired;
    if (isAnonymousRequest) {
      return {};
    }

    const [license, isServerless] = await Promise.all([
      firstValueFrom(license$),
      getIsServerless(),
    ]);
    const mlEnabled = isMlEnabled(license);

    const originalCapabilities = capabilities.ml as MlCapabilities;
    const mlCaps = cloneDeep(originalCapabilities);

    if (capabilities.aiops.enabled === false) {
      mlCaps.canUseAiops = false;
    }

    // full license, leave capabilities as they were
    if (mlEnabled && isFullLicense(license)) {
      return { ml: applyEnabledFeatures(mlCaps, enabledFeatures, isServerless) };
    }

    // not full license, switch off all capabilities
    Object.keys(mlCaps).forEach((k) => {
      mlCaps[k as keyof MlCapabilities] = false;
    });

    // for a basic license, reapply the original capabilities for the basic license features
    if (mlEnabled && isMinimumLicense(license)) {
      basicLicenseMlCapabilities.forEach((c) => (mlCaps[c] = originalCapabilities[c]));
    }

    return { ml: mlCaps };
  };
};

function applyEnabledFeatures(
  mlCaps: MlCapabilities,
  { ad, dfa, nlp }: MlFeatures,
  isServerless: boolean
) {
  mlCaps.isADEnabled = ad;
  mlCaps.isDFAEnabled = dfa;
  mlCaps.isNLPEnabled = nlp;
  mlCaps.canViewMlNodes = mlCaps.canViewMlNodes && isServerless === false;

  if (ad === false) {
    for (const c of featureCapabilities.ad) {
      mlCaps[c] = false;
    }
  }
  if (dfa === false) {
    for (const c of featureCapabilities.dfa) {
      mlCaps[c] = false;
    }
  }
  if (nlp === false && dfa === false) {
    for (const c of featureCapabilities.nlp) {
      mlCaps[c] = false;
    }
  }

  return mlCaps;
}
