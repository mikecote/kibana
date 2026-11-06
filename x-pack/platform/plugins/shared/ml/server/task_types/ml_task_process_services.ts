/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { filter, firstValueFrom } from 'rxjs';
import type { CloudSetup } from '@kbn/cloud-plugin/server';
import type { CoreAuditService } from '@kbn/core-security-server';
import { SavedObjectsClient } from '@kbn/core/server';
import type { RuleTypeModuleDeps } from '@kbn/alerting-plugin/server/task_types/rule_task_type';
import { ML_JOB_SAVED_OBJECT_TYPE } from '@kbn/ml-common-types/saved_objects';
import type { CompatibleModule, MlFeatures } from '../../common/constants/app';
import { MlLicense } from '../../common/license';
import { createMlRunServices } from '../ml_run_services';
import { getMlSavedObjectTypes } from '../saved_objects';

/** What the plugin registers with `registerTaskProcessSettings('ml', ...)`. */
export interface MlTaskProcessSettings {
  cpsEnabled: boolean;
  /** The features this Kibana has enabled (`xpack.ml.ad`, `dfa` and `nlp`). */
  enabledFeatures?: MlFeatures;
  /** `xpack.ml.compatibleModuleType`. */
  compatibleModuleType?: CompatibleModule | null;
}

export const ML_TASK_PROCESS_SETTINGS_ID = 'ml';

/** The saved object types the ML services read, for the `savedObjectTypes` option of a module. */
export const getMlTaskProcessSavedObjectTypes = () =>
  getMlSavedObjectTypes().filter(({ name }) => name === ML_JOB_SAVED_OBJECT_TYPE);

// What a process falls back to when it is not sent the features (a remote process without settings).
const DEFAULT_ENABLED_FEATURES: MlFeatures = Object.freeze({ ad: true, dfa: true, nlp: true });

const kibanaOnly = (what: string) => () => {
  throw new Error(`${what} is only available in Kibana, not in a task process`);
};

/**
 * The ML services a rule type of a task process uses, built from what the host gives the module. They
 * are what Kibana has, for rules, which ask with a fake request: whatever acts for a user (the
 * capabilities, spaces and cloud of a request) throws when used. Nothing is read from the host
 * before a rule runs, so a module can build its rule type without one.
 */
export const createMlTaskProcessServices = (
  deps: Pick<RuleTypeModuleDeps, 'host' | 'runtime' | 'fieldFormats' | 'isServerless' | 'settings'>
) => {
  const mlLicense = new MlLicense();
  const settings = deps.settings[ML_TASK_PROCESS_SETTINGS_ID] as MlTaskProcessSettings | undefined;
  let licensed: Promise<void> | undefined;

  const services = createMlRunServices({
    mlLicense,
    getClusterClient: () => deps.host.elasticsearch,
    getInternalSavedObjectsClient: () =>
      new SavedObjectsClient(deps.host.savedObjects.createInternalRepository()),
    getUiSettings: () => deps.runtime.uiSettings,
    getFieldsFormat: () => deps.fieldFormats,
    getDataViews: () => deps.runtime.dataViews,
    getAuditService: () => deps.host.security.audit as CoreAuditService,
    // A task process has no startup to wait for: the job saved objects are Kibana's to initialize.
    isMlReady: () => Promise.resolve(),
    compatibleModuleType: settings?.compatibleModuleType ?? null,
    enabledFeatures: settings?.enabledFeatures ?? DEFAULT_ENABLED_FEATURES,
    serverless: { isServerless: deps.isServerless, cpsEnabled: settings?.cpsEnabled ?? false },
    // A process runs for a space with the user of a fake request; the spaces plugin is Kibana's.
    getSpaces: kibanaOnly('The spaces plugin'),
    cloud: new Proxy({} as CloudSetup, {
      get: (_, property) => kibanaOnly(`The cloud plugin (${String(property)})`)(),
    }),
    resolveMlCapabilities: kibanaOnly('Resolving the capabilities of a request'),
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
