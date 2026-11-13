/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { WorkflowStepsRegistry } from '@kbn/workflows-extensions/server';
import type { EntityStoreCoreSetup } from '../../types';
import type { EntityStoreStartContract } from '../../types';
import type {
  LicensingStart,
  SecurityStart,
  WorkflowsEventsStart,
} from './update_asset_criticality';
import { getUpdateAssetCriticalityStepDefinition } from './update_asset_criticality';

/**
 * What the steps read of the rest of the system, each read when a step runs: Kibana reads them from
 * the start contracts of the plugins, a task process from its host and the runtime of the engine.
 */
export interface EntityStoreWorkflowStepsServices {
  getCreateCRUDClient: () => Promise<EntityStoreStartContract['createCRUDClient']>;
  getWorkflowsExtensions: () => Promise<WorkflowsEventsStart | undefined>;
  getLicensing: () => Promise<LicensingStart>;
  getSecurity: () => Promise<SecurityStart>;
}

/** Registers the steps of the plugin, in Kibana (`plugin.ts`) and in a task process (the contribution). */
export const registerEntityStoreWorkflowSteps = (
  registry: WorkflowStepsRegistry,
  services: EntityStoreWorkflowStepsServices
): void => {
  registry.registerStepDefinition(
    getUpdateAssetCriticalityStepDefinition(
      services.getCreateCRUDClient,
      services.getWorkflowsExtensions,
      services.getLicensing,
      services.getSecurity
    )
  );
};

export const registerSteps = (
  workflowsExtensions: WorkflowStepsRegistry,
  core: EntityStoreCoreSetup
): void => {
  const startServices = core.getStartServices();

  registerEntityStoreWorkflowSteps(workflowsExtensions, {
    getCreateCRUDClient: () =>
      startServices.then(([, , startContract]) => startContract.createCRUDClient),
    getWorkflowsExtensions: () =>
      startServices.then(([, pluginsStart]) => pluginsStart.workflowsExtensions),
    getLicensing: () => startServices.then(([, pluginsStart]) => pluginsStart.licensing),
    getSecurity: () => startServices.then(([, pluginsStart]) => pluginsStart.security),
  });
};
