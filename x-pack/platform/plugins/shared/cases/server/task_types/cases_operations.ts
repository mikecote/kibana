/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import { defineCapability, remotable } from '@kbn/core-remote-common';
import type { CoordinatorRequestFactory } from '@kbn/task-manager-plugin/server/task_process/coordinator_request';
import { CoordinatorRequestToken } from '@kbn/task-manager-plugin/server/task_process/coordinator_request';
import type { CasesClient } from '../client';
import type { GetCasesClientOptions } from '../client/types';
import type { CasesOperationsApi } from './cases_operations_api';
import { CasesOperationsToken, casesOperationBindings } from './cases_operations_api';

/** Binds the enumerated workflow operations to Main's scoped native Cases client. */
export class CasesOperations implements CasesOperationsApi {
  constructor(
    private readonly requests: CoordinatorRequestFactory,
    private readonly getClient: (
      request: KibanaRequest,
      options?: GetCasesClientOptions
    ) => Promise<CasesClient>
  ) {}

  attachmentsAdd(
    ...args: Parameters<CasesOperationsApi['attachmentsAdd']>
  ): ReturnType<CasesOperationsApi['attachmentsAdd']> {
    return this.#invoke('attachmentsAdd', ...args);
  }

  attachmentsBulkCreate(
    ...args: Parameters<CasesOperationsApi['attachmentsBulkCreate']>
  ): ReturnType<CasesOperationsApi['attachmentsBulkCreate']> {
    return this.#invoke('attachmentsBulkCreate', ...args);
  }

  attachmentsBulkDelete(
    ...args: Parameters<CasesOperationsApi['attachmentsBulkDelete']>
  ): ReturnType<CasesOperationsApi['attachmentsBulkDelete']> {
    return this.#invoke('attachmentsBulkDelete', ...args);
  }

  attachmentsGetAll(
    ...args: Parameters<CasesOperationsApi['attachmentsGetAll']>
  ): ReturnType<CasesOperationsApi['attachmentsGetAll']> {
    return this.#invoke('attachmentsGetAll', ...args);
  }

  casesBulkAddObservables(
    ...args: Parameters<CasesOperationsApi['casesBulkAddObservables']>
  ): ReturnType<CasesOperationsApi['casesBulkAddObservables']> {
    return this.#invoke('casesBulkAddObservables', ...args);
  }

  casesBulkDeleteObservables(
    ...args: Parameters<CasesOperationsApi['casesBulkDeleteObservables']>
  ): ReturnType<CasesOperationsApi['casesBulkDeleteObservables']> {
    return this.#invoke('casesBulkDeleteObservables', ...args);
  }

  casesBulkGet(
    ...args: Parameters<CasesOperationsApi['casesBulkGet']>
  ): ReturnType<CasesOperationsApi['casesBulkGet']> {
    return this.#invoke('casesBulkGet', ...args);
  }

  casesBulkUpdate(
    ...args: Parameters<CasesOperationsApi['casesBulkUpdate']>
  ): ReturnType<CasesOperationsApi['casesBulkUpdate']> {
    return this.#invoke('casesBulkUpdate', ...args);
  }

  casesCreate(
    ...args: Parameters<CasesOperationsApi['casesCreate']>
  ): ReturnType<CasesOperationsApi['casesCreate']> {
    return this.#invoke('casesCreate', ...args);
  }

  casesDelete(
    ...args: Parameters<CasesOperationsApi['casesDelete']>
  ): ReturnType<CasesOperationsApi['casesDelete']> {
    return this.#invoke('casesDelete', ...args);
  }

  casesDeleteObservable(
    ...args: Parameters<CasesOperationsApi['casesDeleteObservable']>
  ): ReturnType<CasesOperationsApi['casesDeleteObservable']> {
    return this.#invoke('casesDeleteObservable', ...args);
  }

  casesFind(
    ...args: Parameters<CasesOperationsApi['casesFind']>
  ): ReturnType<CasesOperationsApi['casesFind']> {
    return this.#invoke('casesFind', ...args);
  }

  casesGet(
    ...args: Parameters<CasesOperationsApi['casesGet']>
  ): ReturnType<CasesOperationsApi['casesGet']> {
    return this.#invoke('casesGet', ...args);
  }

  casesGetCasesByAlertID(
    ...args: Parameters<CasesOperationsApi['casesGetCasesByAlertID']>
  ): ReturnType<CasesOperationsApi['casesGetCasesByAlertID']> {
    return this.#invoke('casesGetCasesByAlertID', ...args);
  }

  casesPush(
    ...args: Parameters<CasesOperationsApi['casesPush']>
  ): ReturnType<CasesOperationsApi['casesPush']> {
    return this.#invoke('casesPush', ...args);
  }

  casesReplaceCustomField(
    ...args: Parameters<CasesOperationsApi['casesReplaceCustomField']>
  ): ReturnType<CasesOperationsApi['casesReplaceCustomField']> {
    return this.#invoke('casesReplaceCustomField', ...args);
  }

  casesSimilar(
    ...args: Parameters<CasesOperationsApi['casesSimilar']>
  ): ReturnType<CasesOperationsApi['casesSimilar']> {
    return this.#invoke('casesSimilar', ...args);
  }

  casesUpdateObservable(
    ...args: Parameters<CasesOperationsApi['casesUpdateObservable']>
  ): ReturnType<CasesOperationsApi['casesUpdateObservable']> {
    return this.#invoke('casesUpdateObservable', ...args);
  }

  configureGet(
    ...args: Parameters<CasesOperationsApi['configureGet']>
  ): ReturnType<CasesOperationsApi['configureGet']> {
    return this.#invoke('configureGet', ...args);
  }

  configureGetConnectors(
    ...args: Parameters<CasesOperationsApi['configureGetConnectors']>
  ): ReturnType<CasesOperationsApi['configureGetConnectors']> {
    return this.#invoke('configureGetConnectors', ...args);
  }

  templatesGetTemplate(
    ...args: Parameters<CasesOperationsApi['templatesGetTemplate']>
  ): ReturnType<CasesOperationsApi['templatesGetTemplate']> {
    return this.#invoke('templatesGetTemplate', ...args);
  }

  async #invoke<Operation extends keyof CasesOperationsApi>(
    operation: Operation,
    ...[identity, options, ...args]: Parameters<CasesOperationsApi[Operation]>
  ): Promise<Awaited<ReturnType<CasesOperationsApi[Operation]>>> {
    // Request construction checks the lease on every operation, even for retained stubs.
    const request = this.requests.create(identity);
    const client = await this.getClient(request, options);
    const [namespace, method] = casesOperationBindings[operation];
    const subclient = client[namespace];
    const call: unknown = Reflect.get(subclient, method);
    if (!Object.hasOwn(subclient, method) || typeof call !== 'function')
      throw new Error(`Missing Cases operation: ${operation}`);
    // The explicit public signatures and bindings are tested together; only this invocation erases the union.
    return (await Reflect.apply(call, subclient, args)) as Awaited<
      ReturnType<CasesOperationsApi[Operation]>
    >;
  }
}
remotable(CasesOperations);

export const defineCasesOperations = (
  getClient: (request: KibanaRequest, options?: GetCasesClientOptions) => Promise<CasesClient>
) =>
  defineCapability({
    token: CasesOperationsToken,
    placement: 'coordinator',
    scope: 'run',
    needs: [CoordinatorRequestToken] as const,
    create: ([requests]) => new CasesOperations(requests, getClient),
  });
