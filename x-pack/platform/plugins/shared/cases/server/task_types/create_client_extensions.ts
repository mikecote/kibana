/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { CasesClientFactoryArgs } from '../client/factory';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';
import type { CasesEventBus } from '../events/event_bus';
import type { CloseReasonValidator } from '../types';
import {
  CASES_CLIENT_CONTRIBUTION_KEY,
  type CasesClientContribution,
  type CasesClientContributionContext,
} from './client_contribution';

export interface CasesClientExtensions {
  closeReasonValidator: CasesClientFactoryArgs['closeReasonValidator'];
  getParityError: () => string | undefined;
  registerAlertStatusListeners: (eventBus: CasesEventBus) => void;
}

/** Restores solution-owned validators and event listeners without routing Cases operations to Main. */
export const createCasesClientExtensions = (
  context: CasesClientContributionContext,
  settings: Pick<
    CasesWorkflowsProcessSettings,
    'closeReasonOwners' | 'hasAlertStatusChangedListeners'
  >
): CasesClientExtensions => {
  const host = context.host as TaskHost;
  const contributions = (host.contributions?.[CASES_CLIENT_CONTRIBUTION_KEY] ??
    []) as CasesClientContribution[];
  const extensions = contributions
    .filter(
      ({ closeReasonOwners, providesAlertStatusListener }) =>
        closeReasonOwners.some((owner) => settings.closeReasonOwners.includes(owner)) ||
        (settings.hasAlertStatusChangedListeners && providesAlertStatusListener)
    )
    .map((contribution) => {
      const extension = contribution.create(context);
      for (const owner of Object.keys(extension.closeReasonValidators ?? {})) {
        if (!contribution.closeReasonOwners.includes(owner)) {
          throw new Error(`Undeclared Cases close reason validator: ${owner}`);
        }
      }
      if (extension.registerAlertStatusListener && !contribution.providesAlertStatusListener) {
        throw new Error('Undeclared Cases alert status listener');
      }
      return extension;
    });
  const validators = new Map<string, CloseReasonValidator>();
  for (const extension of extensions) {
    for (const [owner, validator] of Object.entries(extension.closeReasonValidators ?? {})) {
      if (validators.has(owner))
        throw new Error(`Duplicate Cases close reason validator: ${owner}`);
      validators.set(owner, validator);
    }
  }
  const listeners = extensions.flatMap(({ registerAlertStatusListener }) =>
    registerAlertStatusListener ? [registerAlertStatusListener] : []
  );
  return {
    closeReasonValidator: validators.size
      ? (reason, owner, request) =>
          validators.get(owner)?.(reason, request) ?? Promise.resolve(false)
      : undefined,
    registerAlertStatusListeners: (eventBus) => {
      for (const register of listeners) register(eventBus);
    },
    getParityError: () => {
      const expected = new Set(settings.closeReasonOwners);
      const missing = [...expected].filter((owner) => !validators.has(owner));
      const unexpected = [...validators.keys()].filter((owner) => !expected.has(owner));
      if (missing.length || unexpected.length) {
        return `Cases close reason validators differ from Main: missing [${missing.join(
          ', '
        )}], unexpected [${unexpected.join(', ')}]`;
      }
      if (settings.hasAlertStatusChangedListeners !== listeners.length > 0) {
        return 'Cases alert status listeners differ from Main';
      }
      return undefined;
    },
  };
};
