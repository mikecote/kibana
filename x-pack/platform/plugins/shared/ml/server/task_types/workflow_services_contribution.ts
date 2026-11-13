/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { SavedObjectsClient } from '@kbn/core/server';
import type { AgentBuilderContributionContext } from '@kbn/agent-builder-server';
import type { WorkflowStepsContribution } from '@kbn/workflows-extensions/server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from '@kbn/spaces-plugin/server/task_process_settings';
import type { SpacesTaskProcessSettings } from '@kbn/spaces-plugin/server/task_process_settings';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { createStandaloneFieldFormats } from '@kbn/alerting-plugin/server/task_types/standalone/field_formats';
import type { MlCloud } from '../ml_cloud';
import { MlLicense } from '../../common/license';
import type { MlDataViews, SharedServices } from '../shared_services/shared_services';
import { createMlRunServices } from '../ml_run_services';
import { createInProcessMlCapabilitiesResolver } from '../lib/capabilities/resolve_ml_capabilities_in_process';
import { getMlSavedObjectTypes } from '../saved_objects';
import { createSnapshotModuleFiles } from '../models/data_recognizer/module_files';
import type { MlAgentBuilderSettings } from './agent_builder_contribution';
import { createMlTaskSpaceCapabilities } from './create_ml_task_space_capabilities';

export const ML_WORKFLOW_SETTINGS_ID = 'mlWorkflowRuntime';
export interface MlWorkflowSettings extends MlAgentBuilderSettings {
  cloud: Pick<MlCloud, 'cloudId' | 'baseUrl'> & { isInTrial: boolean };
}

/** Builds the native shared ML setup contract over the worker's Core and plugin services. */
export const createWorkflowMlServices = (
  host: TaskHost,
  snapshot: MlWorkflowSettings,
  getService: AgentBuilderContributionContext['services']['getService']
): SharedServices => {
  const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
  if (!security || !host.licensing || !host.uiSettings)
    throw new Error('Native ML execution requires Security, licensing and UI settings');
  const { license$ } = host.licensing;
  const mlLicense = new MlLicense();
  mlLicense.setup(license$);
  host.onRunEnd?.(async () => mlLicense.unsubscribe());
  const { cloud } = snapshot;
  return createMlRunServices({
    mlLicense,
    getClusterClient: () => host.elasticsearch,
    getInternalSavedObjectsClient: () =>
      new SavedObjectsClient(host.savedObjects.createInternalRepository()),
    getUiSettings: () => host.uiSettings ?? null,
    getFieldsFormat: createStandaloneFieldFormats,
    getDataViews: () => getService<MlDataViews>('dataViews'),
    getAuditService: () => host.security.audit,
    isMlReady: () => Promise.resolve(),
    compatibleModuleType: snapshot.compatibleModuleType,
    enabledFeatures: snapshot.enabledFeatures,
    serverless: { isServerless: host.server.isServerless, cpsEnabled: snapshot.cpsEnabled },
    ...(snapshot.spacesEnabled
      ? { getSpaces: async () => getService<SpacesPluginStart>('spaces') }
      : {}),
    cloud: { cloudId: cloud.cloudId, baseUrl: cloud.baseUrl, isInTrial: () => cloud.isInTrial },
    authorization: security.authz,
    resolveMlCapabilities: createInProcessMlCapabilitiesResolver({
      authorization: security.authz,
      license$,
      enabledFeatures: snapshot.enabledFeatures,
      isServerless: host.server.isServerless,
      spaceCapabilities: snapshot.spacesEnabled
        ? createMlTaskSpaceCapabilities(
            host,
            async () => getService<SpacesPluginStart>('spaces'),
            () => {
              const spacesSettings = host.settings?.[SPACES_TASK_PROCESS_SETTINGS_ID] as
                | SpacesTaskProcessSettings
                | undefined;
              if (!spacesSettings) throw new Error('ML execution requires its Spaces settings');
              return spacesSettings;
            }
          )
        : undefined,
    }),
    moduleFiles: createSnapshotModuleFiles(snapshot.moduleFiles, host.readContent),
  }).sharedServicesProviders;
};

export const contribution: WorkflowStepsContribution = {
  declares: { savedObjectTypes: getMlSavedObjectTypes(), settings: [ML_WORKFLOW_SETTINGS_ID] },
  provides: {
    'ml.setup': ({ host, settings, services }) => {
      const snapshot = settings[ML_WORKFLOW_SETTINGS_ID] as MlWorkflowSettings | undefined;
      if (!snapshot || !services)
        throw new Error('ML services are not enabled in the dispatching Kibana');
      return createWorkflowMlServices(host as TaskHost, snapshot, services.getService);
    },
  },
  register: () => {},
};
