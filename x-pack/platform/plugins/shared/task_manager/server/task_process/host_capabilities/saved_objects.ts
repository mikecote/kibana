/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core-http-server';
import type { Logger } from '@kbn/logging';
import type { ElasticsearchClient } from '@kbn/core-elasticsearch-server';
import type {
  SavedObjectsEncryptionExtensionFactory,
  SavedObjectsExtensions,
  SavedObjectsType,
  ISavedObjectsSpacesExtension,
} from '@kbn/core-saved-objects-server';
import { MAIN_SAVED_OBJECT_INDEX } from '@kbn/core-saved-objects-server';
import { SavedObjectsUtils } from '@kbn/core-saved-objects-utils-server';
import { SavedObjectTypeRegistry } from '@kbn/core-saved-objects-base-server-internal';
import { KibanaMigrator } from '@kbn/core-saved-objects-migration-server-internal';
import {
  SavedObjectsClient,
  SavedObjectsClientProvider,
  SavedObjectsRepository,
} from '@kbn/core-saved-objects-api-server-internal';
import type { TaskHost } from '../../task_type_module';

/**
 * The spaces extension of a task process: the plugin that owns spaces is not running, so the active
 * space is the one the run's fake request carries (`request.spaceId`). It resolves the namespace
 * like Kibana's spaces extension, minus its spaces lookup: `namespaces` are used as given (`*` is
 * not expanded) and an explicit `namespace` is honoured instead of rejected.
 */
export class StandaloneSpacesExtension implements ISavedObjectsSpacesExtension {
  constructor(private readonly activeSpaceId: string) {}

  getCurrentNamespace(namespace: string | undefined) {
    return namespace ?? SavedObjectsUtils.namespaceStringToId(this.activeSpaceId);
  }

  async getSearchableNamespaces(namespaces: string[] | undefined) {
    return namespaces ?? [this.activeSpaceId];
  }

  asScopedToNamespace(namespace: string) {
    return new StandaloneSpacesExtension(namespace);
  }
}

/** The request Core hands an internal client: no user, the default space. */
const INTERNAL_REQUEST = { headers: {}, spaceId: 'default' } as unknown as KibanaRequest;

export interface StandaloneSavedObjects {
  savedObjects: TaskHost['savedObjects'];
  /** Installs the extension that encrypts and decrypts attributes. Call before the first client. */
  setEncryptionExtension: (factory: SavedObjectsEncryptionExtensionFactory) => void;
}

/**
 * Saved objects in a task process, from the building blocks of Core's `SavedObjectsService`: the
 * type registry, a `KibanaMigrator` that only prepares its migration maps, `SavedObjectsRepository`,
 * `SavedObjectsClientProvider` and `SavedObjectsClient`. Like Kibana with the security plugin,
 * request-scoped clients use the internal user: the run's fake request only selects the space and
 * the encryption extension.
 */
export const createStandaloneSavedObjects = ({
  types,
  client,
  logger,
  kibanaVersion,
}: {
  types: SavedObjectsType[];
  client: ElasticsearchClient;
  logger: Logger;
  kibanaVersion: string;
}): StandaloneSavedObjects => {
  const typeRegistry = new SavedObjectTypeRegistry();
  const seen = new Set<string>();
  types.forEach((type) => {
    if (seen.has(type.name)) return;
    seen.add(type.name);
    typeRegistry.registerType(type);
  });

  let encryptionExtensionFactory: SavedObjectsEncryptionExtensionFactory | undefined;

  const migrator = new KibanaMigrator({
    client,
    typeRegistry,
    hashToVersionMap: {},
    // Only what the constructor path reads: a task process never runs a migration.
    soMigrationsConfig: { batchSize: 1000 } as never,
    kibanaIndex: MAIN_SAVED_OBJECT_INDEX,
    kibanaVersion,
    logger,
    docLinks: {} as never,
    waitForMigrationCompletion: false,
    nodeRoles: { backgroundTasks: true, ui: false, migrator: false } as never,
    esCapabilities: {} as never,
  });
  // Builds the active migrations from the registry without touching Elasticsearch. Without it,
  // reading a document throws.
  migrator.prepareMigrations();

  const createInternalRepository = (
    includedHiddenTypes: string[] = [],
    extensions?: SavedObjectsExtensions
  ) => {
    // Types of other plugins do not exist here.
    let hidden = includedHiddenTypes.filter((type) => typeRegistry.getType(type) !== undefined);
    // A repository needs at least one type; a process that only registers hidden types has none
    // visible.
    if (hidden.length === 0 && typeRegistry.getVisibleTypes().length === 0) {
      hidden = typeRegistry.getAllTypes().map((type) => type.name);
    }
    return SavedObjectsRepository.createRepository(
      migrator,
      typeRegistry,
      MAIN_SAVED_OBJECT_INDEX,
      client,
      logger,
      hidden,
      extensions
    );
  };

  // Built on first use, so `setEncryptionExtension` may run after this returns.
  let provider: SavedObjectsClientProvider | undefined;
  const getProvider = () =>
    (provider ??= new SavedObjectsClientProvider({
      defaultClientFactory: ({ includedHiddenTypes, extensions }) =>
        new SavedObjectsClient(createInternalRepository(includedHiddenTypes, extensions)),
      typeRegistry,
      encryptionExtensionFactory,
      spacesExtensionFactory: ({ request }) =>
        new StandaloneSpacesExtension((request as { spaceId?: string })?.spaceId ?? 'default'),
    }));

  return {
    setEncryptionExtension: (factory) => {
      if (provider) throw new Error('The encryption extension must be set before the first client');
      encryptionExtensionFactory = factory;
    },
    savedObjects: {
      getScopedClient: (request, options) => getProvider().getClient(request, options),
      getUnsafeInternalClient: ({ includedHiddenTypes, excludedExtensions = [] } = {}) =>
        new SavedObjectsClient(
          createInternalRepository(
            includedHiddenTypes,
            getProvider().getExtensions(INTERNAL_REQUEST, excludedExtensions)
          )
        ),
      createInternalRepository: (includedHiddenTypes, extensions) =>
        createInternalRepository(includedHiddenTypes, extensions),
      getTypeRegistry: () => typeRegistry,
    },
  };
};
