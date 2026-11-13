/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { defer, filter, firstValueFrom } from 'rxjs';
import { SavedObjectsClient } from '@kbn/core/server';
import type { RuleTypeModuleDeps } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { createWorkflowSpacesServices } from '@kbn/workflows-extensions/server/spaces_runtime_contribution';
import { getSpaceSavedObjectType } from '@kbn/spaces-plugin/server/saved_objects/saved_objects_service';
import { SPACES_TASK_PROCESS_SETTINGS_ID } from '@kbn/spaces-plugin/server/task_process_settings';
import type { SpacesTaskProcessSettings } from '@kbn/spaces-plugin/server/task_process_settings';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import { MlLicense } from '../../common/license';
import { createMlRunServices } from '../ml_run_services';
import { getMlSavedObjectTypes } from '../saved_objects';
import { createSnapshotModuleFiles } from '../models/data_recognizer/module_files';
import { createInProcessMlCapabilitiesResolver } from '../lib/capabilities/resolve_ml_capabilities_in_process';
import { createMlTaskAuthorization } from './create_ml_task_authorization';
import { createMlTaskSpaceCapabilities } from './create_ml_task_space_capabilities';
import type { MlWorkflowSettings } from './workflow_services_contribution';

/** What the plugin registers with `registerTaskProcessSettings('ml', ...)`. */
export interface MlTaskProcessSettings extends MlWorkflowSettings {
  spaces?: SpacesTaskProcessSettings;
}

export const ML_TASK_PROCESS_SETTINGS_ID = 'ml';

/** The saved object types the ML services read, for the `savedObjectTypes` option of a module. */
export const getMlTaskProcessSavedObjectTypes = () => [
  ...getMlSavedObjectTypes(),
  getSpaceSavedObjectType(),
];

/**
 * The ML services a rule type of a task process uses, built from what the host gives the module. They
 * use the native authorization, Spaces and captured Cloud and module services of Kibana.
 */
export const createMlTaskProcessServices = (
  deps: Pick<RuleTypeModuleDeps, 'host' | 'fieldFormats' | 'isServerless' | 'settings'> & {
    runtime: Pick<RuleTypeModuleDeps['runtime'], 'uiSettings' | 'dataViews'>;
  }
) => {
  const mlLicense = new MlLicense();
  const settings = deps.settings[ML_TASK_PROCESS_SETTINGS_ID] as MlTaskProcessSettings | undefined;
  if (!settings) throw new Error('ML rule execution requires its dispatch settings');
  let licensed: Promise<void> | undefined;
  let spaces: SpacesPluginStart | undefined;
  const authorization = createMlTaskAuthorization(deps.host);
  const { cloud } = settings;
  const getSpacesSettings = () => {
    if (!settings.spaces) throw new Error('ML rule execution requires its Spaces settings');
    return settings.spaces;
  };
  const getSpaces = async () => {
    spaces ??= createWorkflowSpacesServices({
      ...deps.host,
      settings: { ...deps.settings, [SPACES_TASK_PROCESS_SETTINGS_ID]: getSpacesSettings() },
    });
    return spaces;
  };

  const services = createMlRunServices({
    mlLicense,
    getClusterClient: () => deps.host.elasticsearch,
    getInternalSavedObjectsClient: () =>
      new SavedObjectsClient(deps.host.savedObjects.createInternalRepository()),
    getUiSettings: () => deps.runtime.uiSettings,
    getFieldsFormat: () => deps.fieldFormats,
    getDataViews: () => deps.runtime.dataViews,
    getAuditService: () => deps.host.security.audit,
    // A task process has no startup to wait for: the job saved objects are Kibana's to initialize.
    isMlReady: () => Promise.resolve(),
    compatibleModuleType: settings.compatibleModuleType,
    enabledFeatures: settings.enabledFeatures,
    serverless: { isServerless: deps.isServerless, cpsEnabled: settings.cpsEnabled },
    ...(settings.spacesEnabled ? { getSpaces } : {}),
    cloud: { cloudId: cloud.cloudId, baseUrl: cloud.baseUrl, isInTrial: () => cloud.isInTrial },
    authorization,
    resolveMlCapabilities: createInProcessMlCapabilitiesResolver({
      authorization,
      license$: defer(() => {
        if (!deps.host.licensing)
          throw new Error('ML rule execution requires the native licensing service');
        return deps.host.licensing.license$;
      }),
      enabledFeatures: settings.enabledFeatures,
      isServerless: deps.isServerless,
      spaceCapabilities: settings.spacesEnabled
        ? createMlTaskSpaceCapabilities(deps.host, getSpaces, getSpacesSettings)
        : undefined,
    }),
    moduleFiles: createSnapshotModuleFiles(settings.moduleFiles),
  });

  /** Resolves once the license is known, which the license checks of the services need. */
  const whenLicensed = () =>
    (licensed ??= (async () => {
      if (!deps.host.licensing) {
        throw new Error('The ML services need the license, which the module must declare');
      }
      mlLicense.setup(deps.host.licensing.license$);
      await firstValueFrom(mlLicense.isLicenseReady$.pipe(filter(Boolean)));
    })());

  return {
    ...services,
    whenLicensed,
    /** The rule type, whose executor first waits for the license, which the services check. */
    withLicense: <RuleType extends { executor: (options: never) => Promise<unknown> }>(
      ruleType: RuleType
    ): RuleType => ({
      ...ruleType,
      executor: async (options: never) => {
        await whenLicensed();
        return ruleType.executor(options);
      },
    }),
  };
};
