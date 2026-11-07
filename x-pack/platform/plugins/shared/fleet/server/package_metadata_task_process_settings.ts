/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { FleetConfigType } from '../common/types';

export const FLEET_PACKAGE_METADATA_SETTINGS_ID = 'fleetPackageMetadata';

export interface FleetPackageMetadataAssets {
  readonly bundledPackages: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly archive: string;
    readonly sha256: string;
  }>;
  readonly gpgKey?: string;
}

export interface FleetPackageMetadataTaskProcessSettings {
  readonly config: FleetConfigType;
  readonly assets: FleetPackageMetadataAssets;
  readonly elasticConnectorsServerlessEnabled: boolean;
  readonly kibanaBranch: string;
  readonly isProductionMode: boolean;
  readonly isFipsEnabled: boolean;
}
