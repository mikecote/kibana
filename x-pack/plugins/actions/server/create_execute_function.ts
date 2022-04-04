/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SavedObjectsClientContract, SavedObjectReference } from '../../../../src/core/server';
import {
  TaskManagerStartContract,
  TaskInstanceWithDeprecatedFields,
} from '../../task_manager/server';
import {
  RawAction,
  ActionTypeRegistryContract,
  PreConfiguredAction,
  ActionTaskExecutorParams,
} from './types';
import { ExecuteOptions as ActionExecutorOptions } from './lib/action_executor';
import { extractSavedObjectReferences, isSavedObjectExecutionSource } from './lib';
import { RelatedSavedObjects } from './lib/related_saved_objects';

interface CreateExecuteFunctionOptions {
  taskManager: TaskManagerStartContract;
  isESOCanEncrypt: boolean;
  actionTypeRegistry: ActionTypeRegistryContract;
  preconfiguredActions: PreConfiguredAction[];
}

export interface ExecuteOptions extends Pick<ActionExecutorOptions, 'params' | 'source'> {
  id: string;
  spaceId: string;
  apiKey: string | null;
  executionId: string;
  consumer?: string;
  relatedSavedObjects?: RelatedSavedObjects;
}

export type ExecutionEnqueuer<T> = (
  unsecuredSavedObjectsClient: SavedObjectsClientContract,
  options: ExecuteOptions[]
) => Promise<T>;

export function createExecutionEnqueuerFunction({
  taskManager,
  actionTypeRegistry,
  isESOCanEncrypt,
  preconfiguredActions,
}: CreateExecuteFunctionOptions): ExecutionEnqueuer<void> {
  return async function execute(
    unsecuredSavedObjectsClient: SavedObjectsClientContract,
    items: ExecuteOptions[]
  ) {
    if (!isESOCanEncrypt) {
      throw new Error(
        `Unable to execute action because the Encrypted Saved Objects plugin is missing encryption key. Please set xpack.encryptedSavedObjects.encryptionKey in the kibana.yml or use the bin/kibana-encryption-keys command.`
      );
    }

    const connectorIds = [...new Set(items.map((item) => item.id))];
    const foundConnectors = await getConnectors(
      unsecuredSavedObjectsClient,
      preconfiguredActions,
      connectorIds
    );

    for (const foundConnector of foundConnectors) {
      validateCanActionBeUsed(foundConnector.connector);

      const { actionTypeId } = foundConnector.connector;
      if (
        !actionTypeRegistry.isActionExecutable(foundConnector.id, actionTypeId, {
          notifyUsage: true,
        })
      ) {
        actionTypeRegistry.ensureActionTypeEnabled(actionTypeId);
      }
    }

    const bulkScheduleOpts: Array<{
      taskInstance: TaskInstanceWithDeprecatedFields;
      references: SavedObjectReference[];
    }> = [];
    for (const item of items) {
      const foundConnector = foundConnectors.find((row) => row.id === item.id)!;
      // Get saved object references from action ID and relatedSavedObjects
      const { references, relatedSavedObjectWithRefs } = extractSavedObjectReferences(
        item.id,
        foundConnector.isPreconfigured,
        item.relatedSavedObjects
      );
      const executionSourceReference = executionSourceAsSavedObjectReferences(item.source);

      const taskReferences = [];
      if (executionSourceReference.references) {
        taskReferences.push(...executionSourceReference.references);
      }
      if (references) {
        taskReferences.push(...references);
      }

      bulkScheduleOpts.push({
        references: taskReferences,
        taskInstance: {
          taskType: `actions:${foundConnector.connector.actionTypeId}`,
          params: {
            spaceId: item.spaceId,
            isPersisted: true,
            taskParams: {
              actionId: item.id,
              params: item.params,
              apiKey: item.apiKey,
              executionId: item.executionId,
              consumer: item.consumer,
              relatedSavedObjects: relatedSavedObjectWithRefs,
            },
          },
        },
      });
    }

    await taskManager.bulkSchedule(bulkScheduleOpts);
  };
}

export function createEphemeralExecutionEnqueuerFunction({
  taskManager,
  actionTypeRegistry,
  preconfiguredActions,
}: CreateExecuteFunctionOptions): ExecutionEnqueuer<void> {
  return async function execute(
    unsecuredSavedObjectsClient: SavedObjectsClientContract,
    items: ExecuteOptions[]
  ): Promise<void> {
    // TODO: make true bulk
    for (const item of items) {
      const { action } = await getAction(
        unsecuredSavedObjectsClient,
        preconfiguredActions,
        item.id
      );
      validateCanActionBeUsed(action);

      const { actionTypeId } = action;
      if (!actionTypeRegistry.isActionExecutable(item.id, actionTypeId, { notifyUsage: true })) {
        actionTypeRegistry.ensureActionTypeEnabled(actionTypeId);
      }

      const taskParams: ActionTaskExecutorParams = {
        spaceId: item.spaceId,
        taskParams: {
          actionId: item.id,
          consumer: item.consumer,
          // Saved Objects won't allow us to enforce unknown rather than any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          params: item.params as Record<string, any>,
          ...(item.apiKey ? { apiKey: item.apiKey } : {}),
          ...(item.executionId ? { executionId: item.executionId } : {}),
        },
        ...executionSourceAsSavedObjectReferences(item.source),
      };

      taskManager.ephemeralRunNow({
        taskType: `actions:${action.actionTypeId}`,
        params: taskParams,
        state: {},
        scope: ['actions'],
      });
    }
  };
}

function validateCanActionBeUsed(action: PreConfiguredAction | RawAction) {
  const { name, isMissingSecrets } = action;
  if (isMissingSecrets) {
    throw new Error(
      `Unable to execute action because no secrets are defined for the "${name}" connector.`
    );
  }
}

function executionSourceAsSavedObjectReferences(executionSource: ActionExecutorOptions['source']) {
  return isSavedObjectExecutionSource(executionSource)
    ? {
        references: [
          {
            name: 'source',
            ...executionSource.source,
          },
        ],
      }
    : {};
}

async function getAction(
  unsecuredSavedObjectsClient: SavedObjectsClientContract,
  preconfiguredActions: PreConfiguredAction[],
  actionId: string
): Promise<{ action: PreConfiguredAction | RawAction; isPreconfigured: boolean }> {
  const pcAction = preconfiguredActions.find((action) => action.id === actionId);
  if (pcAction) {
    return { action: pcAction, isPreconfigured: true };
  }

  const { attributes } = await unsecuredSavedObjectsClient.get<RawAction>('action', actionId);
  return { action: attributes, isPreconfigured: false };
}

async function getConnectors(
  unsecuredSavedObjectsClient: SavedObjectsClientContract,
  preconfiguredConnectors: PreConfiguredAction[],
  connectorIds: string[]
): Promise<
  Array<{ connector: PreConfiguredAction | RawAction; isPreconfigured: boolean; id: string }>
> {
  const result: Array<{
    connector: PreConfiguredAction | RawAction;
    isPreconfigured: boolean;
    id: string;
  }> = [];

  const connectorIdsToFetch = [];
  for (const connectorId of connectorIds) {
    const pcConnector = preconfiguredConnectors.find((connector) => connector.id === connectorId);
    if (pcConnector) {
      result.push({ connector: pcConnector, isPreconfigured: true, id: connectorId });
    } else {
      connectorIdsToFetch.push(connectorId);
    }
  }

  const bulkGetResult = await unsecuredSavedObjectsClient.bulkGet<RawAction>(
    connectorIdsToFetch.map((id) => ({
      id,
      type: 'action',
    }))
  );
  for (const item of bulkGetResult.saved_objects) {
    if (item.error) throw item.error;
    result.push({
      isPreconfigured: false,
      connector: item.attributes,
      id: item.id,
    });
  }

  return result;
}
