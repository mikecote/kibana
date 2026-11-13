/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EncryptedSavedObjectTypeRegistration } from '@kbn/encrypted-saved-objects-plugin/server';
import { TASK_SO_NAME, INVALIDATE_API_KEY_SO_NAME } from './saved_objects';

/** Native encrypted task registrations shared by Main and task workers. */
export const TASK_ENCRYPTED_SAVED_OBJECT_TYPE_REGISTRATIONS: EncryptedSavedObjectTypeRegistration[] =
  [
    {
      type: TASK_SO_NAME,
      attributesToEncrypt: new Set(['apiKey', 'uiamApiKey', 'encryptedCredential']),
      attributesToIncludeInAAD: new Set(['id', 'taskType', 'credential']),
      enforceRandomId: false,
    },
    {
      type: INVALIDATE_API_KEY_SO_NAME,
      attributesToEncrypt: new Set(['uiamApiKey']),
      attributesToIncludeInAAD: new Set(['apiKeyId', 'createdAt']),
    },
  ];
