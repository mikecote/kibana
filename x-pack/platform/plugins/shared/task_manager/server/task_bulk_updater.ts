/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { defaults } from 'lodash';
import type {
  ISavedObjectsRepository,
  SavedObjectsClientContract,
  SavedObjectsServiceStart,
  Logger,
  SavedObjectErrorResult,
  SavedObjectsBulkUpdateObject,
} from '@kbn/core/server';
import {
  isSavedObjectErrorResult,
  SavedObjectsErrorHelpers,
  SECURITY_EXTENSION_ID,
  SPACES_EXTENSION_ID,
} from '@kbn/core/server';
import type {
  ConcreteTaskInstance,
  SerializedConcreteTaskInstance,
  ApiKeyOptions,
  TaskInstance,
} from './task';
import { TaskStatus } from './task';
import type { BulkUpdateOpts, BulkUpdateResult } from './task_store';
import type { ApiKeyStrategy, ApiKeySOFields, InvalidationTarget } from './api_key_strategy';
import type { TaskValidator } from './task_validator';
import { asErr, asOk } from './lib/result_type';
import { SERVICE_ACCOUNT_CREDENTIAL_TYPE } from './lib/service_account_credential';
import {
  taskInstanceToAttributes,
  savedObjectToConcreteTaskInstance,
} from './lib/task_instance_serialization';
import { TASK_SO_NAME } from './saved_objects';

interface TaskBulkUpdaterDependencies {
  logger: Logger;
  savedObjectsRepository: ISavedObjectsRepository;
  getScopedClient: SavedObjectsServiceStart['getScopedClient'];
  getIsSecurityEnabled: () => boolean;
  getApiKeyStrategy: () => ApiKeyStrategy;
  grantApiKeys: (
    docs: TaskInstance[],
    options?: ApiKeyOptions
  ) => Promise<Map<string, ApiKeySOFields> | null>;
  invalidateUnpersistedApiKeys: (fields: Array<ApiKeySOFields | undefined>) => Promise<void>;
  getInvalidationSoClient: () => SavedObjectsClientContract;
  taskValidator: Pick<
    TaskValidator,
    'getValidatedTaskInstanceForUpdating' | 'getValidatedTaskInstanceFromReading'
  >;
  reportError: (error: Error) => void;
}

const getWriteErrorResult = (id: string, error: Error): SavedObjectErrorResult => ({
  id,
  type: 'task',
  error: SavedObjectsErrorHelpers.isSavedObjectsClientError(error)
    ? error.output.payload
    : { error: 'Internal Server Error', message: error.message, statusCode: 500 },
});

export class TaskBulkUpdater {
  constructor(private readonly deps: TaskBulkUpdaterDependencies) {}

  private async regenerateApiKeyFromRequest(docs: ConcreteTaskInstance[], options?: ApiKeyOptions) {
    const hasEncryptedFields = docs.some(docHasEncryptedApiKey);
    const invalidationTargets: Array<{
      taskId: string;
      targets: InvalidationTarget[];
    }> = [];
    let apiKeySOFieldsMap: Map<string, ApiKeySOFields> | null = null;

    // If a task with an API key is updated with a request
    if (hasEncryptedFields && options?.request && options?.regenerateApiKey) {
      const docsWithApiKeys: ConcreteTaskInstance[] = [];

      docs.forEach((taskInstance) => {
        if (
          docHasEncryptedApiKey(taskInstance) &&
          taskInstance.credential?.type !== SERVICE_ACCOUNT_CREDENTIAL_TYPE
        ) {
          docsWithApiKeys.push(taskInstance);
          const targets = this.deps.getApiKeyStrategy().getApiKeyIdsForInvalidation(taskInstance);
          if (targets.length > 0) {
            const { id, status, startedAt } = taskInstance;
            const runningTask =
              status === TaskStatus.Running && startedAt
                ? // Set when replacing the key while the task is running. Together they
                  // identify that run, so invalidation can wait until the task finishes.
                  { taskId: id, taskStartedAt: startedAt.toISOString() }
                : {};
            invalidationTargets.push({
              taskId: id,
              targets: targets.map((target) => ({ ...target, ...runningTask })),
            });
          }
        }
      });

      // and create new API keys using the new request
      if (docsWithApiKeys.length) {
        apiKeySOFieldsMap = await this.deps.grantApiKeys(docsWithApiKeys, options);
      }
    }

    return { apiKeySOFieldsMap, invalidationTargets };
  }

  private getSoClientForUpdate(docs: ConcreteTaskInstance[], options?: ApiKeyOptions) {
    const hasEncryptedFields = docs.some(docHasEncryptedApiKey);

    // If a task with an API key is updated without a request, throw an error.
    if (hasEncryptedFields && !options?.request) {
      throw new Error(
        'Request is not defined but some of the tasks have API key or user scope. Cannot get the encrypted saved objects repository to bulk update tasks.'
      );
    }

    if (options?.request && !hasEncryptedFields) {
      this.deps.logger.debug(
        'Request is defined but none of the tasks have API key or user scope. Using regular saved objects repository to bulk update tasks.'
      );
    }

    // Return scoped client if request is defined AND at least one document has encrypted fields
    if (options?.request && this.deps.getIsSecurityEnabled() && hasEncryptedFields) {
      return this.deps.getScopedClient(options.request, {
        includedHiddenTypes: [TASK_SO_NAME],
        excludedExtensions: [SECURITY_EXTENSION_ID, SPACES_EXTENSION_ID],
      });
    }

    return this.deps.savedObjectsRepository;
  }

  public async bulkUpdate(
    docs: ConcreteTaskInstance[],
    { validate, mergeAttributes = true, options }: BulkUpdateOpts
  ): Promise<BulkUpdateResult[]> {
    const soClientToUpdate = this.getSoClientForUpdate(docs, options);
    const regenerateResult = await this.regenerateApiKeyFromRequest(docs, options);
    const apiKeySOFieldsMap = regenerateResult.apiKeySOFieldsMap || new Map();
    const { invalidationTargets } = regenerateResult;

    // Docs rejected during local validation never reach `bulkUpdate`, so they get no entry in the
    // bulk response; give them an error result so they're reported, and their regenerated keys
    // invalidated, like any other task that fails to update.
    const omittedDocResults: SavedObjectErrorResult[] = [];
    const newDocs = docs.reduce(
      (acc: Map<string, SavedObjectsBulkUpdateObject<SerializedConcreteTaskInstance>>, doc) => {
        try {
          const taskInstance = this.deps.taskValidator.getValidatedTaskInstanceForUpdating(doc, {
            validate,
          });
          const updatedFields = apiKeySOFieldsMap.get(taskInstance.id);
          const apiKey = updatedFields?.apiKey || doc?.apiKey;
          const uiamApiKey = updatedFields?.uiamApiKey || doc?.uiamApiKey;
          const userScope = updatedFields?.userScope || doc?.userScope;
          const { credential, encryptedCredential } = doc;
          // The encryption-aware client can't rewrite such a task: a merged update re-encrypts the
          // API key without credential in its AAD, and a full replace encrypts encryptedCredential
          // twice.
          if (
            (credential !== undefined || encryptedCredential !== undefined) &&
            (apiKey || uiamApiKey)
          ) {
            throw new Error(
              'Task has both a credential and an API key, which this version of Kibana cannot update'
            );
          }

          acc.set(doc.id, {
            type: 'task',
            id: doc.id,
            version: doc.version,
            attributes: {
              ...taskInstanceToAttributes(taskInstance, doc.id),
              ...(apiKey ? { apiKey } : {}),
              ...(uiamApiKey ? { uiamApiKey } : {}),
              ...(userScope ? { userScope } : {}),
              // A full replace drops every attribute it doesn't send. credential is in the AAD, so it
              // and encryptedCredential must be copied unchanged or decryption fails.
              ...(!mergeAttributes && credential !== undefined ? { credential } : {}),
              ...(!mergeAttributes && encryptedCredential !== undefined
                ? { encryptedCredential }
                : {}),
            },
            mergeAttributes,
          });
        } catch (e) {
          this.deps.logger.error(
            `[TaskStore] An error occured. Task ${doc.id} will not be updated. Error: ${e.message}`
          );
          omittedDocResults.push({
            id: doc.id,
            type: 'task',
            error: { error: 'Bad Request', message: e.message, statusCode: 400 },
          });
        }
        return acc;
      },
      new Map()
    );

    // The encryption-aware client would encrypt the stored encryptedCredential ciphertext again,
    // so those tasks are written through the plain repository.
    const objectsToUpdate = Array.from(newDocs.values());
    const plainRepositoryObjects =
      soClientToUpdate === this.deps.savedObjectsRepository
        ? []
        : objectsToUpdate.filter(({ attributes }) => attributes.encryptedCredential !== undefined);
    const soClientObjects = objectsToUpdate.filter(
      (object) => !plainRepositoryObjects.includes(object)
    );

    const [soClientWrite, plainRepositoryWrite] = await Promise.allSettled([
      soClientToUpdate.bulkUpdate<SerializedConcreteTaskInstance>(soClientObjects, {
        refresh: false,
      }),
      plainRepositoryObjects.length
        ? this.deps.savedObjectsRepository.bulkUpdate<SerializedConcreteTaskInstance>(
            plainRepositoryObjects,
            { refresh: false }
          )
        : { saved_objects: [] },
    ]);
    const writes = [
      { objects: soClientObjects, write: soClientWrite },
      { objects: plainRepositoryObjects, write: plainRepositoryWrite },
    ];

    const writeErrors = writes.flatMap(({ write }) =>
      write.status === 'rejected' ? [write.reason] : []
    );
    writeErrors.forEach((e) => this.deps.reportError(e));
    const hasPersistedWrite = writes.some(
      ({ objects, write }) => objects.length > 0 && write.status === 'fulfilled'
    );
    if (writeErrors.length && !hasPersistedWrite) {
      await this.deps.invalidateUnpersistedApiKeys([...apiKeySOFieldsMap.values()]);
      throw writeErrors[0];
    }

    // A failed write fails only its own tasks, so the other write's results are kept.
    const updatedSavedObjects = [
      ...writes.flatMap(({ objects, write }) =>
        write.status === 'fulfilled'
          ? write.value.saved_objects
          : objects.map(({ id }) => getWriteErrorResult(id, write.reason))
      ),
      ...omittedDocResults,
    ];

    const allInvalidationTargets: InvalidationTarget[] = [];

    const updates = updatedSavedObjects.map((updatedSavedObject) => {
      if (isSavedObjectErrorResult(updatedSavedObject)) {
        // The regenerated key never made it onto the task, so nothing references it. Queue it
        // alongside the replaced keys below rather than leaving it orphaned.
        const granted = apiKeySOFieldsMap.get(updatedSavedObject.id);
        if (granted) {
          allInvalidationTargets.push(
            ...this.deps.getApiKeyStrategy().getApiKeyIdsForInvalidation(granted)
          );
        }
        return asErr({
          type: 'task',
          id: updatedSavedObject.id,
          error: updatedSavedObject.error,
        });
      }

      const taskInstance = savedObjectToConcreteTaskInstance({
        ...updatedSavedObject,
        attributes: defaults(
          updatedSavedObject.attributes,
          newDocs.get(updatedSavedObject.id)?.attributes as SerializedConcreteTaskInstance
        ),
      });
      const result = this.deps.taskValidator.getValidatedTaskInstanceFromReading(taskInstance, {
        validate,
      });
      const entry = invalidationTargets.find((t) => t.taskId === updatedSavedObject.id);
      if (entry) {
        allInvalidationTargets.push(...entry.targets);
      }
      return asOk(result);
    });

    if (allInvalidationTargets.length) {
      await this.deps
        .getApiKeyStrategy()
        .markForInvalidation(
          allInvalidationTargets,
          this.deps.logger,
          this.deps.getInvalidationSoClient()
        );
    }

    return updates;
  }
}

export function docHasEncryptedApiKey(
  doc: Pick<ConcreteTaskInstance, 'apiKey' | 'uiamApiKey' | 'userScope'>
): boolean {
  return Boolean((doc.apiKey || doc.uiamApiKey) && doc.userScope);
}
