/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import nodeCrypto from '@elastic/node-crypto';
import { createHash } from 'crypto';

import type {
  CoreStart,
  ISavedObjectTypeRegistry,
  Logger,
  SavedObjectsServiceSetup,
} from '@kbn/core/server';

import type { ConfigType } from './config';
import { getCreateMigration } from './create_migration';
import { getCreateEsoModelVersion } from './create_model_version';
import {
  EncryptedSavedObjectsService,
  type EncryptedSavedObjectTypeRegistration,
  EncryptionError,
} from './crypto';
import { SavedObjectsEncryptionExtension, setupSavedObjects } from './saved_objects';
import type { EncryptedSavedObjectsPluginSetup, EncryptedSavedObjectsPluginStart } from './types';

/** Creates the encryption runtime shared by the server and task plugins. */
export const createEncryptedSavedObjectsRuntime = ({
  config,
  logger,
  savedObjects,
  getCoreStart,
}: {
  config: ConfigType;
  logger: Logger;
  savedObjects: SavedObjectsServiceSetup;
  getCoreStart: () => Promise<Pick<CoreStart, 'savedObjects' | 'security'>>;
}): {
  service: Readonly<EncryptedSavedObjectsService>;
  setup: EncryptedSavedObjectsPluginSetup;
  start: EncryptedSavedObjectsPluginStart;
} => {
  const canEncrypt = config.encryptionKey !== undefined;
  if (!canEncrypt) {
    logger.warn(
      'Saved objects encryption key is not set. This will severely limit Kibana functionality. ' +
        'Please set xpack.encryptedSavedObjects.encryptionKey in the kibana.yml or use the bin/kibana-encryption-keys command.'
    );
  } else {
    const hashedEncryptionKey = createHash('sha3-256')
      .update(config.encryptionKey)
      .digest('base64');

    logger.info(
      `Hashed 'xpack.encryptedSavedObjects.encryptionKey' for this instance: ${hashedEncryptionKey}`
    );
  }

  const readOnlyKeys = config.keyRotation?.decryptionOnlyKeys;

  if (readOnlyKeys !== undefined && readOnlyKeys.length > 0) {
    const readOnlyKeyHashses = readOnlyKeys.map((readOnlyKey, i) =>
      createHash('sha3-256').update(readOnlyKey).digest('base64')
    );

    logger.info(
      `Hashed 'xpack.encryptedSavedObjects.keyRotation.decryptionOnlyKeys' for this instance: ${readOnlyKeyHashses}`
    );
  }

  const primaryCrypto = config.encryptionKey
    ? nodeCrypto({ encryptionKey: config.encryptionKey })
    : undefined;
  const decryptionOnlyCryptos = config.keyRotation.decryptionOnlyKeys.map((decryptionKey) =>
    nodeCrypto({ encryptionKey: decryptionKey })
  );

  const service = Object.freeze(
    new EncryptedSavedObjectsService({
      primaryCrypto,
      decryptionOnlyCryptos,
      logger,
    })
  );

  const savedObjectsSetup = setupSavedObjects({
    service,
    savedObjects,
    getCoreStart,
    logger,
  });

  const setup: EncryptedSavedObjectsPluginSetup = {
    canEncrypt,
    registerType: (typeRegistration: EncryptedSavedObjectTypeRegistration) => {
      service?.registerType(typeRegistration);
    },
    createMigration: getCreateMigration(
      service,
      (typeRegistration: EncryptedSavedObjectTypeRegistration) => {
        const serviceForMigration = new EncryptedSavedObjectsService({
          primaryCrypto,
          decryptionOnlyCryptos,
          logger,
        });
        serviceForMigration.registerType(typeRegistration);
        return serviceForMigration;
      }
    ),
    createModelVersion: getCreateEsoModelVersion(
      service,
      (typeRegistration: EncryptedSavedObjectTypeRegistration) => {
        const serviceForMigration = new EncryptedSavedObjectsService({
          primaryCrypto,
          decryptionOnlyCryptos,
          logger,
        });
        serviceForMigration.registerType(typeRegistration);
        return serviceForMigration;
      }
    ),
    getKeysForTaskProcesses: () => ({
      encryptionKey: config.encryptionKey,
      decryptionOnlyKeys: [...(readOnlyKeys ?? [])],
    }),
    __testCreateDangerousExtension: (
      typeRegistry: ISavedObjectTypeRegistry,
      typeRegistrationOverrides?: EncryptedSavedObjectTypeRegistration[]
    ): SavedObjectsEncryptionExtension => {
      return new SavedObjectsEncryptionExtension({
        baseTypeRegistry: typeRegistry,
        service: service.__dangerousClone(typeRegistrationOverrides),
        getCurrentUser: async () => undefined,
      });
    },
  };

  return {
    service,
    setup,
    start: {
      isEncryptionError: (error) => error instanceof EncryptionError,
      getClient: savedObjectsSetup,
    },
  };
};
