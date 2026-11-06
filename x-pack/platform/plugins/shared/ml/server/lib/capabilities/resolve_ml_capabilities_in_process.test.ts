/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { of } from 'rxjs';
import type { KibanaRequest } from '@kbn/core/server';
import { getDefaultMlCapabilities } from '@kbn/ml-common-types/capabilities';
import { createInProcessMlCapabilitiesResolver } from './resolve_ml_capabilities_in_process';

const request = {} as KibanaRequest;

const license = (type: 'platinum' | 'basic') =>
  ({
    status: 'active',
    type,
    isActive: true,
    hasAtLeast: (minimum: string) => (type === 'platinum' ? true : minimum === 'basic'),
    getFeature: () => ({ isAvailable: true, isEnabled: true }),
    check: (_plugin: string, minimum: string) => ({
      state: type === 'platinum' || minimum === 'basic' ? 'valid' : 'invalid',
    }),
  } as never);

const setup = ({
  granted,
  licenseType = 'platinum',
  enabledFeatures = { ad: true, dfa: true, nlp: true },
}: {
  granted: (capability: string) => boolean;
  licenseType?: 'platinum' | 'basic';
  enabledFeatures?: { ad: boolean; dfa: boolean; nlp: boolean };
}) => {
  const check = jest.fn(async ({ kibana }: { kibana: string[] }) => ({
    privileges: {
      kibana: kibana.map((privilege) => ({
        privilege,
        authorized: granted(privilege.replace('ui:ml/', '')),
      })),
    },
  }));
  const authorization = {
    actions: { ui: { get: (app: string, capability: string) => `ui:${app}/${capability}` } },
    checkPrivilegesDynamicallyWithRequest: jest.fn().mockReturnValue(check),
  };
  return createInProcessMlCapabilitiesResolver({
    authorization: authorization as never,
    license$: of(license(licenseType)) as never,
    enabledFeatures,
    isServerless: false,
  });
};

describe('createInProcessMlCapabilitiesResolver', () => {
  it('grants the capabilities the user has a privilege for with a full license', async () => {
    const resolve = setup({ granted: (capability) => capability === 'canGetJobs' });

    const capabilities = await resolve(request);

    expect(capabilities?.canGetJobs).toBe(true);
    expect(capabilities?.canCreateJob).toBe(false);
    expect(Object.keys(capabilities!).sort()).toEqual(
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
});
