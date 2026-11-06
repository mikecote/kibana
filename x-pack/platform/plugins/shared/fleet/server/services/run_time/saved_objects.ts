/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SavedObjectsType } from '@kbn/core-saved-objects-server';
import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';

import {
  AGENT_POLICY_SAVED_OBJECT_TYPE,
  LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
  LEGACY_PACKAGE_POLICY_SAVED_OBJECT_TYPE,
  MESSAGE_SIGNING_KEYS_SAVED_OBJECT_TYPE,
  OUTPUT_SAVED_OBJECT_TYPE,
  PACKAGES_SAVED_OBJECT_TYPE,
  PACKAGE_POLICY_SAVED_OBJECT_TYPE,
  UNINSTALL_TOKENS_SAVED_OBJECT_TYPE,
  DOWNLOAD_SOURCE_SAVED_OBJECT_TYPE,
  FLEET_SERVER_HOST_SAVED_OBJECT_TYPE,
  FLEET_PROXY_SAVED_OBJECT_TYPE,
  SPACE_SETTINGS_SAVED_OBJECT_TYPE,
  GLOBAL_SETTINGS_SAVED_OBJECT_TYPE,
  ASSETS_SAVED_OBJECT_TYPE,
} from '../../constants';
import { getEncryptedSavedObjectTypes, getSavedObjectTypes } from '../../saved_objects';

/**
 * The saved object types the response action services read or write, as Kibana registers them, for
 * a task process to register with Core. A type that Kibana registers elsewhere (the rule and SLO
 * template types Fleet asks its internal clients for) has to be registered by its own owner.
 */
const RUN_TYPE_NAMES: string[] = [
  AGENT_POLICY_SAVED_OBJECT_TYPE,
  LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
  PACKAGE_POLICY_SAVED_OBJECT_TYPE,
  LEGACY_PACKAGE_POLICY_SAVED_OBJECT_TYPE,
  PACKAGES_SAVED_OBJECT_TYPE,
  ASSETS_SAVED_OBJECT_TYPE,
  OUTPUT_SAVED_OBJECT_TYPE,
  DOWNLOAD_SOURCE_SAVED_OBJECT_TYPE,
  FLEET_SERVER_HOST_SAVED_OBJECT_TYPE,
  FLEET_PROXY_SAVED_OBJECT_TYPE,
  SPACE_SETTINGS_SAVED_OBJECT_TYPE,
  GLOBAL_SETTINGS_SAVED_OBJECT_TYPE,
  MESSAGE_SIGNING_KEYS_SAVED_OBJECT_TYPE,
  UNINSTALL_TOKENS_SAVED_OBJECT_TYPE,
];

export const getFleetRunSavedObjectTypes = (
  options: { useSpaceAwareness: boolean } = { useSpaceAwareness: false }
): SavedObjectsType[] => {
  const types = getSavedObjectTypes(options);
  return RUN_TYPE_NAMES.map((name) => types[name]).filter(Boolean);
};

/** The encrypted saved objects Fleet registers in Kibana, which a task process registers too. */
export const getFleetRunEncryptedSavedObjectTypes = (): EncryptedSavedObjectTypeRegistration[] =>
  getEncryptedSavedObjectTypes();
