/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import murmurhash from 'murmurhash';
import { omit } from 'lodash';
import type { SavedObject } from '@kbn/core-saved-objects-common';
import { brandSpaceId } from '@kbn/core-spaces-common';
import type { ConcreteTaskInstance, SerializedConcreteTaskInstance, TaskInstance } from '../task';
import { MAX_PARTITIONS } from './task_partitioner';

/** Kept apart from `task_store.ts` so a task process can serialize tasks without the whole store. */
export function taskInstanceToAttributes(
  doc: TaskInstance,
  id: string
): SerializedConcreteTaskInstance {
  return {
    ...omit(
      doc,
      'id',
      'version',
      'userScope',
      'apiKey',
      'uiamApiKey',
      'credential',
      'encryptedCredential',
      'runAs'
    ),
    params: JSON.stringify(doc.params || {}),
    state: JSON.stringify(doc.state || {}),
    attempts: (doc as ConcreteTaskInstance).attempts || 0,
    scheduledAt: (doc.scheduledAt || new Date()).toISOString(),
    startedAt: (doc.startedAt && doc.startedAt.toISOString()) || null,
    retryAt: (doc.retryAt && doc.retryAt.toISOString()) || null,
    runAt: (doc.runAt || new Date()).toISOString(),
    status: (doc as ConcreteTaskInstance).status || 'idle',
    partition: doc.partition || murmurhash.v3(id) % MAX_PARTITIONS,
  } as SerializedConcreteTaskInstance;
}

export function savedObjectToConcreteTaskInstance(
  savedObject: Omit<SavedObject<SerializedConcreteTaskInstance>, 'references'>
): ConcreteTaskInstance {
  const { userScope, ...attributes } = savedObject.attributes;
  return {
    ...attributes,
    ...(userScope
      ? {
          userScope: {
            ...userScope,
            ...(userScope.spaceId ? { spaceId: brandSpaceId(userScope.spaceId) } : {}),
          },
        }
      : {}),
    id: savedObject.id,
    version: savedObject.version,
    scheduledAt: new Date(savedObject.attributes.scheduledAt),
    runAt: new Date(savedObject.attributes.runAt),
    startedAt: savedObject.attributes.startedAt ? new Date(savedObject.attributes.startedAt) : null,
    retryAt: savedObject.attributes.retryAt ? new Date(savedObject.attributes.retryAt) : null,
    state: parseJSONField(savedObject.attributes.state, 'state', savedObject.id),
    params: parseJSONField(savedObject.attributes.params, 'params', savedObject.id),
  };
}

function parseJSONField(json: string, fieldName: string, id: string) {
  try {
    return json ? JSON.parse(json) : {};
  } catch (error) {
    throw new Error(`Task "${id}"'s ${fieldName} field has invalid JSON: ${json}`);
  }
}
