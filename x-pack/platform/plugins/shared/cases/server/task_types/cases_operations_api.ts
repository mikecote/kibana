/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createToken } from '@kbn/core-remote-common';
import type { CoordinatorRequestIdentity } from '@kbn/task-manager-plugin/server/task_process/coordinator_request';
import { remote } from '../remote';
import type { CasesClient } from '../client';
import type { GetCasesClientOptions } from '../client/types';

type ScopedOperation<Method extends (...args: never[]) => unknown> = (
  identity: CoordinatorRequestIdentity,
  options: GetCasesClientOptions | undefined,
  ...args: Parameters<Method>
) => Promise<Awaited<ReturnType<Method>>>;

/** Inventory of client calls in server/workflows/steps: every line is an explicit placement decision. */
export interface CasesOperationsApi {
  // attachments
  attachmentsAdd: ScopedOperation<CasesClient['attachments']['add']>;
  attachmentsBulkCreate: ScopedOperation<CasesClient['attachments']['bulkCreate']>;
  attachmentsBulkDelete: ScopedOperation<CasesClient['attachments']['bulkDelete']>;
  attachmentsGetAll: ScopedOperation<CasesClient['attachments']['getAll']>;
  // cases
  casesBulkAddObservables: ScopedOperation<CasesClient['cases']['bulkAddObservables']>;
  casesBulkDeleteObservables: ScopedOperation<CasesClient['cases']['bulkDeleteObservables']>;
  casesBulkGet: ScopedOperation<CasesClient['cases']['bulkGet']>;
  casesBulkUpdate: ScopedOperation<CasesClient['cases']['bulkUpdate']>;
  casesCreate: ScopedOperation<CasesClient['cases']['create']>;
  casesDelete: ScopedOperation<CasesClient['cases']['delete']>;
  casesDeleteObservable: ScopedOperation<CasesClient['cases']['deleteObservable']>;
  casesFind: ScopedOperation<CasesClient['cases']['find']>;
  casesGet: ScopedOperation<CasesClient['cases']['get']>;
  casesGetCasesByAlertID: ScopedOperation<CasesClient['cases']['getCasesByAlertID']>;
  casesPush: ScopedOperation<CasesClient['cases']['push']>;
  casesReplaceCustomField: ScopedOperation<CasesClient['cases']['replaceCustomField']>;
  casesSimilar: ScopedOperation<CasesClient['cases']['similar']>;
  casesUpdateObservable: ScopedOperation<CasesClient['cases']['updateObservable']>;
  // configure
  configureGet: ScopedOperation<CasesClient['configure']['get']>;
  configureGetConnectors: ScopedOperation<CasesClient['configure']['getConnectors']>;
  // templates
  templatesGetTemplate: ScopedOperation<CasesClient['templates']['getTemplate']>;
}

export const CasesOperationsToken = createToken<CasesOperationsApi>(
  remote.capabilities.CasesOperations.token
);

// Internal forwarding bindings; this is deliberately not a generic public RPC tunnel.
export const casesOperationBindings = {
  attachmentsAdd: ['attachments', 'add'],
  attachmentsBulkCreate: ['attachments', 'bulkCreate'],
  attachmentsBulkDelete: ['attachments', 'bulkDelete'],
  attachmentsGetAll: ['attachments', 'getAll'],
  casesBulkAddObservables: ['cases', 'bulkAddObservables'],
  casesBulkDeleteObservables: ['cases', 'bulkDeleteObservables'],
  casesBulkGet: ['cases', 'bulkGet'],
  casesBulkUpdate: ['cases', 'bulkUpdate'],
  casesCreate: ['cases', 'create'],
  casesDelete: ['cases', 'delete'],
  casesDeleteObservable: ['cases', 'deleteObservable'],
  casesFind: ['cases', 'find'],
  casesGet: ['cases', 'get'],
  casesGetCasesByAlertID: ['cases', 'getCasesByAlertID'],
  casesPush: ['cases', 'push'],
  casesReplaceCustomField: ['cases', 'replaceCustomField'],
  casesSimilar: ['cases', 'similar'],
  casesUpdateObservable: ['cases', 'updateObservable'],
  configureGet: ['configure', 'get'],
  configureGetConnectors: ['configure', 'getConnectors'],
  templatesGetTemplate: ['templates', 'getTemplate'],
} as const satisfies Record<keyof CasesOperationsApi, readonly [keyof CasesClient, string]>;
