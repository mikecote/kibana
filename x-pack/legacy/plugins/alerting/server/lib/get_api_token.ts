/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { EncryptedSavedObjectsPlugin } from '../../../encrypted_saved_objects';

export async function getApiToken(
  encryptedSavedObjectsPlugin: EncryptedSavedObjectsPlugin,
  id: string,
  namespace: string
) {
  const {
    attributes: { apiKeyId, generatedApiKey },
  } = await encryptedSavedObjectsPlugin.getDecryptedAsInternalUser('alert', id, { namespace });
  return Buffer.from(`${apiKeyId}:${generatedApiKey}`).toString('base64');
}
