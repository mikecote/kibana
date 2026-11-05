/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { createHash } from 'node:crypto';
import {
  getManagedWorkflowDefinition,
  type ManagedWorkflowDefinition,
  type ManagedWorkflowId,
} from '@kbn/workflows/managed';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import type {
  GetManagedWorkflowStatusOptions,
  ManagedWorkflowOperationOptions,
  ManagedWorkflowStatus,
  ManagedWorkflowStatusReport,
} from '@kbn/workflows/server/types';
import type { WorkflowReadService } from './workflow_read_service';
import type { WorkflowProperties } from '../storage/workflow_storage';

/**
 * What a managed workflow's status is computed from: its definition in the registry and the document
 * that is stored. The managed workflows service and a task process (which only reads) share it.
 */

export const computeDefinitionHash = (yaml: string): string => {
  return createHash('sha256').update(yaml.trim()).digest('hex');
};

export const computeManagedDefinitionHash = (definition: ManagedWorkflowDefinition): string => {
  if (definition.yamlTemplate) {
    return computeDefinitionHash(definition.yamlTemplate.toString());
  }
  if (!definition.yaml) {
    throw new Error(`Managed workflow '${definition.id}' must define either yaml or yamlTemplate`);
  }
  return computeDefinitionHash(definition.yaml);
};

export const assertPluginRegistration = (
  definition: ManagedWorkflowDefinition,
  registeredPluginId: string
): void => {
  if (registeredPluginId !== definition.pluginId) {
    throw new Error(
      `Managed workflow '${definition.id}' is owned by plugin '${definition.pluginId}' but was registered by '${registeredPluginId}'`
    );
  }
};

export const resolveWorkflowDocumentId = (
  id: string,
  options: ManagedWorkflowOperationOptions
): string => {
  const customId = options.workflowId?.trim();
  const suffix = options.workflowIdSuffix?.trim();

  if (customId && suffix) {
    throw new Error(
      `Managed workflow '${id}' cannot be installed with both workflowId and workflowIdSuffix`
    );
  }

  if (suffix) {
    return `${id}-${suffix}`;
  }

  if (customId) {
    if (!customId.startsWith(`${id}-`) && customId !== id) {
      throw new Error(
        `Managed workflow '${id}' custom workflowId must equal '${id}' or start with '${id}-'`
      );
    }
    return customId;
  }

  return id;
};

export const getRequiredSpaceId = (options: ManagedWorkflowOperationOptions): string => {
  const spaceId = options.spaceId?.trim();
  if (!spaceId) {
    throw new Error(
      `Managed workflow operations require an explicit spaceId. Use '${GLOBAL_WORKFLOW_SPACE_ID}' for global workflows.`
    );
  }
  return spaceId;
};

export const createManagedWorkflowStatusReport = (params: {
  status: ManagedWorkflowStatus;
  workflowDocumentId: string;
  definitionId: ManagedWorkflowId;
  spaceId: string;
  definition: ManagedWorkflowDefinition;
  registryHash: string;
  existing?: WorkflowProperties;
}): ManagedWorkflowStatusReport => {
  const { status, workflowDocumentId, definitionId, spaceId, definition, registryHash, existing } =
    params;

  return {
    status,
    workflowId: workflowDocumentId,
    definitionId,
    spaceId: existing?.spaceId ?? spaceId,
    installed: Boolean(existing),
    enabled: existing?.enabled ?? null,
    valid: existing?.valid ?? null,
    managedBy: existing?.managedBy ?? null,
    storedVersion: existing?.managedVersion ?? null,
    registryVersion: definition.version,
    storedHash: existing?.definitionHash ?? null,
    registryHash,
  };
};

export const getManagedWorkflowStatus = async ({
  reader,
  id,
  options,
  registeredPluginId,
}: {
  reader: Pick<WorkflowReadService, 'getWorkflowDocumentSource'>;
  id: ManagedWorkflowId;
  options: GetManagedWorkflowStatusOptions;
  registeredPluginId: string;
}): Promise<ManagedWorkflowStatusReport> => {
  const definition = getManagedWorkflowDefinition(id);
  if (!definition) {
    throw new Error(`Unknown managed workflow id: ${id}`);
  }
  assertPluginRegistration(definition, registeredPluginId);

  const workflowDocumentId = resolveWorkflowDocumentId(id, options);
  const spaceId = getRequiredSpaceId(options);
  const registryHash = computeManagedDefinitionHash(definition);
  const existing = await reader.getWorkflowDocumentSource(workflowDocumentId, spaceId, {
    includeDeleted: true,
    includeGlobal: true,
  });

  if (!existing || existing.deleted_at) {
    return createManagedWorkflowStatusReport({
      status: 'missing',
      workflowDocumentId,
      definitionId: id,
      spaceId,
      definition,
      registryHash,
    });
  }

  if (existing.managed !== true) {
    return createManagedWorkflowStatusReport({
      status: 'not_managed',
      workflowDocumentId,
      definitionId: id,
      spaceId,
      definition,
      registryHash,
      existing,
    });
  }

  const storedHash = existing.definitionHash ?? null;
  const storedVersion = existing.managedVersion ?? null;
  let status: ManagedWorkflowStatus = 'intact';
  if (!existing.valid || !existing.definition) {
    status = 'invalid';
  } else if (!existing.enabled) {
    status = 'disabled';
  } else if (
    storedHash !== registryHash ||
    storedVersion !== definition.version ||
    existing.originManagedWorkflowId !== definition.id
  ) {
    status = 'drifted';
  }

  return createManagedWorkflowStatusReport({
    status,
    workflowDocumentId,
    definitionId: id,
    spaceId,
    definition,
    registryHash,
    existing,
  });
};
