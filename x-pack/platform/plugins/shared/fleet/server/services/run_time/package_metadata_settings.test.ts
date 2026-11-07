/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateKey, readKey } from 'openpgp';

import { coreMock } from '@kbn/core/server/mocks';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';

import type { FleetConfigType } from '../../../common/types';
import { parseExperimentalConfigValue } from '../../../common/experimental_features';

import { appContextService } from '../app_context';
import { _purgeBundledPackagesCache } from '../epm/packages/bundled_packages';

import {
  createBundledPackagesFromSnapshot,
  getFleetPackageMetadataTaskProcessSettings,
} from './package_metadata_settings';

describe('portable Fleet package metadata material', () => {
  it('captures the native files and cached signing key, then reads archives after the host files are gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-package-material-'));
    const bundles = join(directory, 'bundled');
    const keyPath = join(directory, 'signing-key');
    const archive = Buffer.from('owned-package-archive');
    const { publicKey } = await generateKey({
      type: 'ecc',
      curve: 'curve25519',
      userIDs: [{ name: 'Task package fixture' }],
      format: 'armored',
    });
    try {
      await mkdir(bundles);
      await writeFile(join(bundles, 'custom-1.0.0.zip'), archive);
      await writeFile(keyPath, publicKey);
      const config: FleetConfigType = {
        enabled: true,
        agents: { enabled: true, elasticsearch: {} },
        registryUrl: 'https://registry.example.test',
        developer: { bundledPackageLocation: bundles },
        packageVerification: { gpgKeyPath: keyPath },
      };
      const core = coreMock.createStart();
      const nativeContext = {
        elasticsearch: core.elasticsearch.client,
        savedObjects: core.savedObjects,
        securitySetup: securityMock.createSetup(),
        registry: { kind: 'native' } as const,
        configInitialValue: config,
        experimentalFeatures: parseExperimentalConfigValue([], {}),
        logger: loggingSystemMock.createLogger(),
        kibanaVersion: '9.9.9',
        kibanaBranch: 'owned-branch',
        kibanaInstanceId: 'owned-instance',
        isProductionMode: false,
        isFipsEnabled: false,
      };
      appContextService.startExecution(nativeContext);
      _purgeBundledPackagesCache();
      const snapshot = await getFleetPackageMetadataTaskProcessSettings();
      expect(snapshot).toEqual(
        expect.objectContaining({
          config,
          kibanaBranch: 'owned-branch',
          isProductionMode: false,
          isFipsEnabled: false,
          elasticConnectorsServerlessEnabled: false,
        })
      );
      expect(snapshot.assets.bundledPackages).toEqual([
        {
          name: 'custom',
          version: '1.0.0',
          archive: archive.toString('base64'),
          sha256: createHash('sha256').update(archive).digest('hex'),
        },
      ]);
      const { gpgKey } = snapshot.assets;
      expect(gpgKey).toBeDefined();
      if (!gpgKey) throw new Error('The native signing key was not captured');
      const original = await readKey({ armoredKey: publicKey });
      const captured = await readKey({ armoredKey: gpgKey });
      expect(captured.getFingerprint()).toBe(original.getFingerprint());

      await rm(directory, { recursive: true });
      const [restored] = createBundledPackagesFromSnapshot(snapshot.assets);
      expect(await restored.getBuffer()).toEqual(archive);
      await jest.isolateModulesAsync(async () => {
        const { appContextService: worker } = await import('../app_context');
        const { getBundledPackages } = await import('../epm/packages/bundled_packages');
        const { getGpgKeyOrUndefined } = await import('../epm/packages/package_verification');
        worker.startExecution({
          ...nativeContext,
          registry: { kind: 'snapshot', settings: snapshot },
        });
        try {
          const [ownedArchive] = await getBundledPackages();
          expect(await ownedArchive.getBuffer()).toEqual(archive);
          const ownedKey = await getGpgKeyOrUndefined();
          expect(ownedKey?.getFingerprint()).toBe(original.getFingerprint());
        } finally {
          worker.stop();
        }
      });
    } finally {
      appContextService.stop();
      _purgeBundledPackagesCache();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects archive content that does not match the dispatch snapshot', async () => {
    const [archive] = createBundledPackagesFromSnapshot({
      bundledPackages: [
        {
          name: 'custom',
          version: '1.0.0',
          archive: Buffer.from('changed').toString('base64'),
          sha256: createHash('sha256').update('original').digest('hex'),
        },
      ],
    });
    await expect(archive.getBuffer()).rejects.toThrow('does not match its dispatch snapshot');
  });
});
