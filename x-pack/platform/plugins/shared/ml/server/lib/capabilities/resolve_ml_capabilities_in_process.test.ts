/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of, throwError } from 'rxjs';
import { httpServerMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { License } from '@kbn/licensing-plugin/common/license';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { asSpaceId } from '@kbn/core-spaces-common';
import { KibanaFeature } from '@kbn/features-plugin/server';
import { createSpacesCapabilitiesSwitcher } from '@kbn/spaces-plugin/server';
import { getDefaultMlCapabilities } from '@kbn/ml-common-types/capabilities';
import { createInProcessMlCapabilitiesResolver } from './resolve_ml_capabilities_in_process';
import type { ILicense } from '@kbn/licensing-types';
import type { Observable } from 'rxjs';

const request = httpServerMock.createKibanaRequest();

const license = (type: 'platinum' | 'basic') =>
  new License({
    license: {
      uid: 'ml',
      type,
      mode: type,
      status: 'active',
      expiryDateInMillis: Date.now() + 86_400_000,
    },
    features: { ml: { isAvailable: true, isEnabled: true } },
    signature: 'signature',
  });

const setup = ({
  granted,
  licenseType = 'platinum',
  enabledFeatures = { ad: true, dfa: true, nlp: true },
  disabledFeatures = () => [],
  license$ = of(license(licenseType)),
}: {
  granted: (capability: string) => boolean;
  licenseType?: 'platinum' | 'basic';
  enabledFeatures?: { ad: boolean; dfa: boolean; nlp: boolean };
  disabledFeatures?: () => string[];
  license$?: Observable<ILicense>;
}) => {
  const authorization = securityMock.createSetup().authz;
  jest
    .mocked(authorization.actions.ui.get)
    .mockImplementation((feature, ...parts) => `ui:${feature}/${parts.join('/')}`);
  const check = jest.fn(async ({ kibana }: { kibana: string[] }) => ({
    privileges: {
      kibana: kibana.map((privilege) => ({
        privilege,
        authorized: granted(privilege.split('/').at(-1) ?? ''),
      })),
    },
  }));
  authorization.checkPrivilegesDynamicallyWithRequest.mockReturnValue(check);
  const logger = loggingSystemMock.createLogger();
  return createInProcessMlCapabilitiesResolver({
    authorization,
    license$,
    enabledFeatures,
    isServerless: false,
    spaceCapabilities: createSpacesCapabilitiesSwitcher({
      logger,
      getActiveSpace: async () => ({
        id: asSpaceId('default'),
        name: 'Default',
        disabledFeatures: disabledFeatures(),
      }),
      getKibanaFeatures: async () =>
        ['ml', 'aiops'].map(
          (id) =>
            new KibanaFeature({
              id,
              name: id,
              app: [id],
              category: { id: 'analytics', label: 'Analytics' },
              privileges: null,
            })
        ),
    }),
  });
};

describe('createInProcessMlCapabilitiesResolver', () => {
  it('fails explicitly when the native license cannot be read', async () => {
    const resolve = setup({
      granted: () => true,
      license$: throwError(() => new Error('License unavailable')),
    });
    await expect(resolve(request)).rejects.toThrow('License unavailable');
  });
  it('grants the capabilities the user has a privilege for with a full license', async () => {
    const resolve = setup({ granted: (capability) => capability === 'canGetJobs' });

    const capabilities = await resolve(request);

    expect(capabilities?.canGetJobs).toBe(true);
    expect(capabilities?.canCreateJob).toBe(false);
    expect(Object.keys(capabilities ?? {}).sort()).toEqual(
      Object.keys(getDefaultMlCapabilities()).sort()
    );
  });

  it('switches off what the features of this Kibana disable', async () => {
    const resolve = setup({
      granted: () => true,
      enabledFeatures: { ad: false, dfa: true, nlp: true },
    });

    const capabilities = await resolve(request);

    expect(capabilities?.isADEnabled).toBe(false);
    expect(capabilities?.canCreateJob).toBe(false);
    expect(capabilities?.isDFAEnabled).toBe(true);
  });

  it('switches off everything but what the basic license allows', async () => {
    const resolve = setup({ granted: () => true, licenseType: 'basic' });

    const capabilities = await resolve(request);

    expect(capabilities?.canCreateJob).toBe(false);
    expect(capabilities?.canGetJobs).toBe(false);
  });

  it('reads current disabled features on each invocation without retaining permissions', async () => {
    let disabledFeatures: string[] = [];
    const resolve = setup({ granted: () => true, disabledFeatures: () => disabledFeatures });
    expect((await resolve(request))?.canGetJobs).toBe(true);
    disabledFeatures = ['ml'];
    expect((await resolve(request))?.canGetJobs).toBe(false);
    disabledFeatures = [];
    expect((await resolve(request))?.canGetJobs).toBe(true);
  });

  it('uses the native ML gate when AIOps is disabled in the active space', async () => {
    const resolve = setup({ granted: () => true, disabledFeatures: () => ['aiops'] });
    expect((await resolve(request))?.canUseAiops).toBe(false);
    expect((await resolve(request))?.canGetJobs).toBe(true);
  });
});
