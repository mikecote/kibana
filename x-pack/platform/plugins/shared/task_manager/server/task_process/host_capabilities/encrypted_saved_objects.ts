/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import nodeCrypto from '@elastic/node-crypto';
import type { Logger } from '@kbn/logging';
import type { ISavedObjectTypeRegistry } from '@kbn/core-saved-objects-server';
import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';
import {
  EncryptedSavedObjectsService,
  EncryptionError,
} from '@kbn/encrypted-saved-objects-plugin/server/crypto';
import { setupSavedObjects } from '@kbn/encrypted-saved-objects-plugin/server/saved_objects';
import { ConfigSchema } from '@kbn/encrypted-saved-objects-plugin/server/config';
import type { TaskHost } from '../../task_type_module';
import type { StandaloneSavedObjects } from './saved_objects';

/**
 * Encrypted saved objects in a task process: the same service, client and encryption extension as
 * the plugin. The process needs the same keys as Kibana, which it gets over the fork channel (or
 * its environment), so a process that has them can decrypt any encrypted saved object.
 */
export const createStandaloneEncryptedSavedObjects = ({
  keys,
  registrations,
  standalone,
  logger,
}: {
  keys?: { encryptionKey?: string; decryptionOnlyKeys: string[] };
  registrations: EncryptedSavedObjectTypeRegistration[];
  standalone: StandaloneSavedObjects;
  logger: Logger;
}): NonNullable<TaskHost['encryptedSavedObjects']> => {
  // The plugin's own schema rejects a short key or a primary key listed as decryption only.
  // `dist` so that a missing key stays missing instead of getting the development default.
  const config = ConfigSchema.validate(
    {
      ...(keys?.encryptionKey ? { encryptionKey: keys.encryptionKey } : {}),
      keyRotation: { decryptionOnlyKeys: keys?.decryptionOnlyKeys ?? [] },
    },
    { dist: true }
  );
  const canEncrypt = config.encryptionKey !== undefined;
  if (!canEncrypt) {
    logger.warn(
      'xpack.encryptedSavedObjects.encryptionKey is not set: decrypting saved objects will fail'
    );
  }
  const service = new EncryptedSavedObjectsService({
    primaryCrypto: config.encryptionKey
      ? nodeCrypto({ encryptionKey: config.encryptionKey })
      : undefined,
    decryptionOnlyCryptos: config.keyRotation.decryptionOnlyKeys.map((decryptionKey) =>
      nodeCrypto({ encryptionKey: decryptionKey })
    ),
    logger,
  });
  registrations.forEach((registration) => service.registerType(registration));

  const getClient = setupSavedObjects({
    service,
    savedObjects: { setEncryptionExtension: standalone.setEncryptionExtension } as never,
    getStartServices: (async () => [
      {
        savedObjects: {
          createInternalRepository: standalone.savedObjects.createInternalRepository,
          getTypeRegistry: standalone.savedObjects
            .getTypeRegistry as () => ISavedObjectTypeRegistry,
        },
        // Decrypting only records who did it; a process has no user.
        security: { authc: { getCurrentUser: () => null } },
      },
      {},
    ]) as never,
    logger,
  });

  return {
    getClient,
    isEncryptionError: (error) => error instanceof EncryptionError,
    canEncrypt,
  };
};
