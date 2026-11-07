/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import { encryptedSavedObjectsMock } from '@kbn/encrypted-saved-objects-plugin/server/mocks';
import { PRECONFIGURATION_DELETION_RECORD_SAVED_OBJECT_TYPE } from '../constants';
import type { FleetPackageMetadataTaskProcessSettings } from '../package_metadata_task_process_settings';
import { contribution } from './workflow_services_contribution';

describe('native Fleet workflow services', () => {
  it.each([true, false])(
    'preserves captured space awareness in native type definitions (%s)',
    (useSpaceAwareness) => {
      const metadata: FleetPackageMetadataTaskProcessSettings = {
        config: {
          enabled: true,
          agents: { enabled: true, elasticsearch: {} },
          experimentalFeatures: { useSpaceAwareness },
        },
        assets: { bundledPackages: [] },
        elasticConnectorsServerlessEnabled: false,
        kibanaBranch: 'main',
        isProductionMode: false,
        isFipsEnabled: false,
      };
      const types = contribution.declares?.createSavedObjectTypes?.(
        encryptedSavedObjectsMock.createSetup(),
        { fleetPackageMetadata: metadata }
      );
      expect(
        types?.find(({ name }) => name === PRECONFIGURATION_DELETION_RECORD_SAVED_OBJECT_TYPE)
          ?.namespaceType
      ).toBe(useSpaceAwareness ? 'single' : 'agnostic');
    }
  );

  it('rejects native service construction when the dispatching Fleet plugin is absent', () => {
    const provider = contribution.provides?.['fleet.runServices'];
    if (!provider) throw new Error('Fleet native services provider is not registered');
    expect(() =>
      provider({
        host: {},
        logger: loggingSystemMock.createLogger(),
        isServerless: false,
        kibanaVersion: '9.6.0',
        settings: {},
      })
    ).toThrow('Fleet workflow services require the fleetPackageMetadata snapshot');
  });
});
