/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { merge } from 'lodash';
import type { Observable } from 'rxjs';
import type { Capabilities, CapabilitiesSwitcher, KibanaRequest } from '@kbn/core/server';
import type { ILicense } from '@kbn/licensing-types';
import { getDefaultMlCapabilities } from '@kbn/ml-common-types/capabilities';
import type { MlCapabilities, ResolveMlCapabilities } from '@kbn/ml-common-types/capabilities';
import type { MlFeatures } from '../../../common/constants/app';
import type { MlAuthorizationService } from './check_capabilities';
import { createMlCapabilitiesSwitcher } from './capabilities_switcher';

/** Resolves task ML privileges through the native Spaces and ML capability gates. */
export const createInProcessMlCapabilitiesResolver = ({
  authorization,
  license$,
  enabledFeatures,
  isServerless,
  spaceCapabilities,
}: {
  authorization: MlAuthorizationService;
  license$: Observable<ILicense>;
  enabledFeatures: MlFeatures;
  isServerless: boolean;
  spaceCapabilities?: CapabilitiesSwitcher;
}): ResolveMlCapabilities => {
  const mlSwitcher = createMlCapabilitiesSwitcher({
    license$,
    enabledFeatures,
    getIsServerless: async () => isServerless,
  });
  return async (request: KibanaRequest): Promise<MlCapabilities | null> => {
    const defaults = getDefaultMlCapabilities();
    const keys = Object.keys(defaults) as Array<keyof MlCapabilities>;
    const actions = keys.map((key) => authorization.actions.ui.get('ml', key));
    const { privileges } = await authorization.checkPrivilegesDynamicallyWithRequest(request)({
      kibana: actions,
    });
    const granted = new Set(
      privileges.kibana.filter(({ authorized }) => authorized).map(({ privilege }) => privilege)
    );
    keys.forEach((key, index) => {
      defaults[key] = granted.has(actions[index]);
    });
    const capabilities: Capabilities = {
      navLinks: {},
      management: {},
      catalogue: {},
      aiops: { enabled: true },
      ml: defaults,
    };
    const scoped = spaceCapabilities
      ? merge({}, capabilities, await spaceCapabilities(request, capabilities, false))
      : capabilities;
    const resolved = merge({}, scoped, await mlSwitcher(request, scoped, false));
    return resolved.ml as MlCapabilities;
  };
};
