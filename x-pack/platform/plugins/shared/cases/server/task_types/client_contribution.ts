/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  WorkflowStepsContribution,
  WorkflowStepsContributionContext,
} from '@kbn/workflows-extensions/server';
import type { CloseReasonValidator } from '../types';
import type { CasesEventBus } from '../events/event_bus';

export const CASES_CLIENT_CONTRIBUTION_KEY = 'cases-client';

export interface CasesClientExtension {
  closeReasonValidators?: Readonly<Record<string, CloseReasonValidator>>;
  registerAlertStatusListener?: (eventBus: CasesEventBus) => void;
}

export type CasesClientContributionContext = Pick<
  WorkflowStepsContributionContext,
  'host' | 'logger' | 'settings'
> & {
  services?: Pick<NonNullable<WorkflowStepsContributionContext['services']>, 'getService'>;
};

export interface CasesClientContribution {
  readonly closeReasonOwners: readonly string[];
  readonly providesAlertStatusListener?: boolean;
  declares?: WorkflowStepsContribution['declares'];
  create: (context: CasesClientContributionContext) => CasesClientExtension;
}
