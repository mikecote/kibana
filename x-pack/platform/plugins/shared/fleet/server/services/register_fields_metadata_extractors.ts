/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Logger } from '@kbn/core/server';

import type {
  FieldsMetadataExtractors,
  FieldsMetadataServerSetup,
} from '@kbn/fields-metadata-plugin/server';

import type { FleetStartContract, FleetStartDeps } from '../plugin';

import { appContextService } from '.';

export const FLEET_FIELDS_METADATA_EXTRACTOR_ID = 'fleet';

type PackageMetadataClient = Pick<
  FleetStartContract['packageService']['asInternalUser'],
  'getPackageFieldsMetadata' | 'getPackages'
>;

/** Creates Fleet's field metadata extractors from its package client. */
export const createFleetFieldsMetadataExtractors = ({
  getPackageService,
  getLogger,
}: {
  getPackageService: () => Promise<PackageMetadataClient>;
  getLogger: () => Pick<Logger, 'warn'>;
}): Required<
  Pick<FieldsMetadataExtractors, 'integrationFieldsExtractor' | 'integrationListExtractor'>
> => ({
  integrationFieldsExtractor: async ({ integration, dataset }) => {
    try {
      const packages = await getPackageService();
      return packages.getPackageFieldsMetadata({ packageName: integration, datasetName: dataset });
    } catch (error) {
      getLogger().warn(`registerIntegrationFieldsExtractor error: ${error}`);
      throw error;
    }
  },
  integrationListExtractor: async () => {
    const packages = await getPackageService();
    try {
      const entries = await packages.getPackages();
      return entries.map(({ id, name, version }) => ({ id, name, version }));
    } catch (error) {
      return [];
    }
  },
});

interface RegistrationDeps {
  core: CoreSetup<FleetStartDeps, FleetStartContract>;
  fieldsMetadata: Pick<
    FieldsMetadataServerSetup,
    'registerIntegrationFieldsExtractor' | 'registerIntegrationListExtractor'
  >;
}

/** Registers the shared Fleet extractors with the native field metadata registry. */
export const registerFieldsMetadataExtractors = ({
  core,
  fieldsMetadata,
}: RegistrationDeps): void => {
  const extractors = createFleetFieldsMetadataExtractors({
    getPackageService: async () => {
      const [, , { packageService }] = await core.getStartServices();
      return packageService.asInternalUser;
    },
    getLogger: () => appContextService.getLogger(),
  });
  fieldsMetadata.registerIntegrationFieldsExtractor(
    extractors.integrationFieldsExtractor,
    FLEET_FIELDS_METADATA_EXTRACTOR_ID
  );
  fieldsMetadata.registerIntegrationListExtractor(
    extractors.integrationListExtractor,
    FLEET_FIELDS_METADATA_EXTRACTOR_ID
  );
};
