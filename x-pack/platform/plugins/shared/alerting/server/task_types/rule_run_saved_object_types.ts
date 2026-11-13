/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getSpaceSavedObjectType } from '@kbn/spaces-plugin/server/saved_objects/saved_objects_service';
import type { SavedObjectsServiceSetup, SavedObjectsType } from '@kbn/core/server';
import type {
  EncryptedSavedObjectTypeRegistration,
  EncryptedSavedObjectsPluginSetup,
} from '@kbn/encrypted-saved-objects-plugin/server';
import { setupSavedObjects as setupActionsSavedObjects } from '@kbn/actions-plugin/server/saved_objects';
import {
  ACTION_SAVED_OBJECT_TYPE,
  ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
} from '@kbn/actions-plugin/server/constants/saved_objects';
import { maintenanceWindowSavedObjectType } from '@kbn/maintenance-windows-plugin/server/saved_objects';
import { dataViewSavedObjectType } from '@kbn/data-views-plugin/server/saved_objects/data_views';
import { RULES_SETTINGS_SAVED_OBJECT_TYPE } from '../../common';
import {
  RULE_SAVED_OBJECT_TYPE,
  setupSavedObjects as setupAlertingSavedObjects,
} from '../saved_objects';

/** What a rule run reads and writes, which a task process has to know to use it. */
const SAVED_OBJECT_TYPES = new Set([
  RULE_SAVED_OBJECT_TYPE,
  RULES_SETTINGS_SAVED_OBJECT_TYPE,
  ACTION_SAVED_OBJECT_TYPE,
  ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
]);
const ENCRYPTED_SAVED_OBJECT_TYPES = new Set([
  RULE_SAVED_OBJECT_TYPE,
  ACTION_SAVED_OBJECT_TYPE,
  ACTION_TASK_PARAMS_SAVED_OBJECT_TYPE,
]);

const unusedInAProcess = (what: string) => () => {
  throw new Error(`${what} is not available in a task process`);
};

/**
 * The saved object types and encrypted registrations a rule run needs, collected from the code that
 * registers them in Kibana (alerting's and actions' `setupSavedObjects`), so both always agree.
 * Migrations are built but never run: Kibana migrates every document before any task runs.
 */
export const getRuleRunDeclarations = (): {
  savedObjectTypes: SavedObjectsType[];
  encryptedSavedObjectTypes: EncryptedSavedObjectTypeRegistration[];
} => {
  const savedObjectTypes: SavedObjectsType[] = [];
  const encryptedSavedObjectTypes: EncryptedSavedObjectTypeRegistration[] = [];
  const savedObjects = {
    registerType: (type: SavedObjectsType) => savedObjectTypes.push(type),
  } as unknown as SavedObjectsServiceSetup;
  const encryptedSavedObjects = {
    canEncrypt: true,
    registerType: (registration: EncryptedSavedObjectTypeRegistration) =>
      encryptedSavedObjectTypes.push(registration),
    createMigration: () => unusedInAProcess('A saved object migration'),
    createModelVersion: ({ modelVersion }: { modelVersion: unknown }) => modelVersion,
  } as unknown as EncryptedSavedObjectsPluginSetup;
  const logger = { debug: () => undefined, warn: () => undefined } as never;

  setupAlertingSavedObjects(
    savedObjects,
    encryptedSavedObjects,
    {} as never,
    logger,
    () => false,
    () => ({})
  );
  setupActionsSavedObjects(
    savedObjects,
    encryptedSavedObjects,
    {} as never,
    '',
    [],
    () => undefined
  );

  return {
    savedObjectTypes: [
      ...savedObjectTypes.filter((type) => SAVED_OBJECT_TYPES.has(type.name)),
      maintenanceWindowSavedObjectType,
      dataViewSavedObjectType,
      getSpaceSavedObjectType(),
    ],
    encryptedSavedObjectTypes: encryptedSavedObjectTypes.filter((registration) =>
      ENCRYPTED_SAVED_OBJECT_TYPES.has(registration.type)
    ),
  };
};
