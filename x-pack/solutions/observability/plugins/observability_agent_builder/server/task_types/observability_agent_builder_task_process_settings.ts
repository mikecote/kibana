/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ObservabilityDataProviderRegistration } from '../data_registry/data_registry';

export const OBSERVABILITY_AGENT_BUILDER_TASK_PROCESS_SETTINGS_ID =
  'observabilityAgentBuilderRuntime';

export interface ObservabilityAgentBuilderRegistrations {
  toolIds: string[];
  attachmentTypeIds: string[];
  skillIds: string[];
}

export type ObservabilityAgentBuilderRegistrationState = {
  [Kind in keyof ObservabilityAgentBuilderRegistrations]: Set<string>;
};

export interface ObservabilityAgentBuilderTaskProcessSettings {
  registrations: ObservabilityAgentBuilderRegistrations;
  dataProviders: ObservabilityDataProviderRegistration[];
  mlEnabled: boolean;
  spacesEnabled: boolean;
}

export const createObservabilityAgentBuilderRegistrationState =
  (): ObservabilityAgentBuilderRegistrationState => ({
    toolIds: new Set(),
    attachmentTypeIds: new Set(),
    skillIds: new Set(),
  });

/** Copies the current successful native registrations into a dispatch snapshot. */
export const getObservabilityAgentBuilderTaskProcessSettings = ({
  registrations,
  dataProviders,
  ...settings
}: Omit<ObservabilityAgentBuilderTaskProcessSettings, 'registrations'> & {
  registrations: ObservabilityAgentBuilderRegistrationState;
}): ObservabilityAgentBuilderTaskProcessSettings => ({
  ...settings,
  registrations: {
    toolIds: [...registrations.toolIds].sort(),
    attachmentTypeIds: [...registrations.attachmentTypeIds].sort(),
    skillIds: [...registrations.skillIds].sort(),
  },
  dataProviders: dataProviders.map((provider) => ({ ...provider })),
});
