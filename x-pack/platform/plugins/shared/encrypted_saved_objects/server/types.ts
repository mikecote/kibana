/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ISavedObjectTypeRegistry } from '@kbn/core/server';

import type { CreateEncryptedSavedObjectsMigrationFn } from './create_migration';
import type { CreateEsoModelVersionFn } from './create_model_version';
import type { EncryptedSavedObjectTypeRegistration } from './crypto';
import type { ClientInstanciator, SavedObjectsEncryptionExtension } from './saved_objects';

export interface EncryptedSavedObjectsPluginSetup {
  /**
   * Indicates if Saved Object encryption is possible. Requires an encryption key to be explicitly set via `xpack.encryptedSavedObjects.encryptionKey`.
   */
  canEncrypt: boolean;
  registerType: (typeRegistration: EncryptedSavedObjectTypeRegistration) => void;
  createMigration: CreateEncryptedSavedObjectsMigrationFn;
  createModelVersion: CreateEsoModelVersionFn;
  /**
   * The keys a task process needs to decrypt what Kibana encrypts, which Kibana sends it over the
   * fork channel. Only for Task Manager's task type modules: whoever has the keys can decrypt any
   * encrypted saved object, so never log or persist the result.
   */
  getKeysForTaskProcesses: () => { encryptionKey?: string; decryptionOnlyKeys: string[] };
  /**
   * This function is exposed for Core migration testing purposes only.
   */
  __testCreateDangerousExtension: (
    typeRegistry: ISavedObjectTypeRegistry,
    typeRegistrationOverrides?: EncryptedSavedObjectTypeRegistration[]
  ) => SavedObjectsEncryptionExtension;
}

export interface EncryptedSavedObjectsPluginStart {
  isEncryptionError: (error: Error) => boolean;
  getClient: ClientInstanciator;
}
