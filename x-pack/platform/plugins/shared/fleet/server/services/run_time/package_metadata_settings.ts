/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'node:crypto';

import type { BundledPackage } from '../../../common/types';
import type {
  FleetPackageMetadataAssets,
  FleetPackageMetadataTaskProcessSettings,
} from '../../package_metadata_task_process_settings';

import { appContextService } from '../app_context';
import { getBundledPackages } from '../epm/packages/bundled_packages';
import { getGpgKeyOrUndefined } from '../epm/packages/package_verification';
import { getElasticConnectorsServerlessEnabled } from '../epm/filtered_packages';

export { FLEET_PACKAGE_METADATA_SETTINGS_ID } from '../../package_metadata_task_process_settings';
export type {
  FleetPackageMetadataAssets,
  FleetPackageMetadataTaskProcessSettings,
} from '../../package_metadata_task_process_settings';

/** Captures the registry configuration and native file material a remote execution needs. */
export const getFleetPackageMetadataTaskProcessSettings =
  async (): Promise<FleetPackageMetadataTaskProcessSettings> => {
    const config = appContextService.getConfig();
    if (!config)
      throw new Error('Fleet package metadata settings are unavailable before Fleet starts');
    const [packages, key] = await Promise.all([getBundledPackages(), getGpgKeyOrUndefined()]);
    const bundledPackages = await Promise.all(
      packages.map(async ({ name, version, getBuffer }) => {
        const buffer = await getBuffer();
        return {
          name,
          version,
          archive: buffer.toString('base64'),
          sha256: createHash('sha256').update(buffer).digest('hex'),
        };
      })
    );
    return {
      config,
      assets: { bundledPackages, gpgKey: key?.armor() },
      elasticConnectorsServerlessEnabled: getElasticConnectorsServerlessEnabled() === true,
      kibanaBranch: appContextService.getKibanaBranch(),
      isProductionMode: appContextService.getIsProductionMode(),
      isFipsEnabled: appContextService.getIsFipsEnabled(),
    };
  };

/** Reads captured package archives in memory and checks their content before native parsing. */
export const createBundledPackagesFromSnapshot = (
  assets: FleetPackageMetadataAssets
): BundledPackage[] =>
  assets.bundledPackages.map(({ name, version, archive, sha256 }) => ({
    name,
    version,
    getBuffer: async () => {
      const buffer = Buffer.from(archive, 'base64');
      if (createHash('sha256').update(buffer).digest('hex') !== sha256) {
        throw new Error(`Bundled package ${name}-${version} does not match its dispatch snapshot`);
      }
      return buffer;
    },
  }));
