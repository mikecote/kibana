/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SignificantEventsRequiredPlugin } from '../../common';

export const SIGNIFICANT_EVENTS_TASK_PROCESS_SETTINGS_ID = 'significantEvents';

export interface SignificantEventsRegistrations {
  toolIds: string[];
  attachmentTypeIds: string[];
  agentTypeIds: string[];
  skillIds: string[];
  smlTypeIds: string[];
}

export type SignificantEventsRegistrationState = {
  [Kind in keyof SignificantEventsRegistrations]: Set<string>;
};

export interface SignificantEventsTaskProcessSettings {
  cpsEnabled: boolean;
  availability: {
    deploymentSupported: boolean;
    pricingTierAvailable: boolean;
    requiredPlugins: SignificantEventsRequiredPlugin[];
  };
  registrations: SignificantEventsRegistrations;
}

/** Creates the registration state updated only after native registry calls succeed. */
export const createSignificantEventsRegistrationState = (): SignificantEventsRegistrationState => ({
  toolIds: new Set(),
  attachmentTypeIds: new Set(),
  agentTypeIds: new Set(),
  skillIds: new Set(),
  smlTypeIds: new Set(),
});

/** Copies current registration and availability metadata into a dispatch snapshot. */
export const getSignificantEventsTaskProcessSettings = ({
  registrations,
  ...settings
}: Omit<SignificantEventsTaskProcessSettings, 'registrations'> & {
  registrations: SignificantEventsRegistrationState;
}): SignificantEventsTaskProcessSettings => ({
  ...settings,
  availability: {
    ...settings.availability,
    requiredPlugins: [...settings.availability.requiredPlugins],
  },
  registrations: {
    toolIds: [...registrations.toolIds].sort(),
    attachmentTypeIds: [...registrations.attachmentTypeIds].sort(),
    agentTypeIds: [...registrations.agentTypeIds].sort(),
    skillIds: [...registrations.skillIds].sort(),
    smlTypeIds: [...registrations.smlTypeIds].sort(),
  },
});
