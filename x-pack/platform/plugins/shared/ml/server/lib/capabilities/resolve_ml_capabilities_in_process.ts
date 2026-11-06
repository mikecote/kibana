/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import type { Observable } from 'rxjs';
import type { KibanaRequest } from '@kbn/core/server';
import type { ILicense } from '@kbn/licensing-types';
import {
  basicLicenseMlCapabilities,
  featureCapabilities,
  getDefaultMlCapabilities,
} from '@kbn/ml-common-types/capabilities';
import type { MlCapabilities, ResolveMlCapabilities } from '@kbn/ml-common-types/capabilities';
import type { MlFeatures } from '../../../common/constants/app';
import { isFullLicense, isMinimumLicense, isMlEnabled } from '../../../common/license';
import type { MlAuthorizationService } from './check_capabilities';

/**
 * The ML capabilities of a request in a task process, which has no Core capabilities service to ask:
 * a capability is granted when the user has the `ui:ml/<capability>` privilege (what the features
 * registry grants through the Kibana privileges of ML), then the license and the features this Kibana
 * enabled switch off what they do not allow, as the switcher of the plugin does. The space's disabled
 * features are not applied (a run has the user of its request, with the privileges the user holds).
 */
export const createInProcessMlCapabilitiesResolver =
  ({
    authorization,
    license$,
    enabledFeatures,
    isServerless,
  }: {
    authorization: MlAuthorizationService;
    license$: Observable<ILicense>;
    enabledFeatures: MlFeatures;
    isServerless: boolean;
  }): ResolveMlCapabilities =>
  async (request: KibanaRequest): Promise<MlCapabilities | null> => {
    const defaults = getDefaultMlCapabilities();
    const keys = Object.keys(defaults) as Array<keyof MlCapabilities>;
    const actions = keys.map((key) => authorization.actions.ui.get('ml', key));
    const { privileges } = await authorization.checkPrivilegesDynamicallyWithRequest(request)({
      kibana: actions,
    });
    const granted = new Set(
      privileges.kibana.filter(({ authorized }) => authorized).map(({ privilege }) => privilege)
    );
    const original = Object.fromEntries(
      keys.map((key, index) => [key, granted.has(actions[index])])
    ) as unknown as MlCapabilities;

    const license = await firstValueFrom(license$);
    const mlCaps = { ...original };
    if (isMlEnabled(license) && isFullLicense(license)) {
      mlCaps.isADEnabled = enabledFeatures.ad;
      mlCaps.isDFAEnabled = enabledFeatures.dfa;
      mlCaps.isNLPEnabled = enabledFeatures.nlp;
      mlCaps.canViewMlNodes = mlCaps.canViewMlNodes && !isServerless;
      if (!enabledFeatures.ad) featureCapabilities.ad.forEach((key) => (mlCaps[key] = false));
      if (!enabledFeatures.dfa) featureCapabilities.dfa.forEach((key) => (mlCaps[key] = false));
      if (!enabledFeatures.nlp && !enabledFeatures.dfa) {
        featureCapabilities.nlp.forEach((key) => (mlCaps[key] = false));
      }
      return mlCaps;
    }
    // Not a full license: everything is off, and the basic license keeps what it allows.
    keys.forEach((key) => (mlCaps[key] = false));
    if (isMlEnabled(license) && isMinimumLicense(license)) {
      basicLicenseMlCapabilities.forEach((key) => (mlCaps[key] = original[key]));
    }
    return mlCaps;
  };
