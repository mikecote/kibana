/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { defer } from 'rxjs';
import { SavedObjectsClient } from '@kbn/core/server';
import type { CoreAuditService } from '@kbn/core-security-server';
import type { AgentBuilderContribution } from '@kbn/agent-builder-server';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { MlAuthorizationService } from '../lib/capabilities/check_capabilities';
import type { CompatibleModule, MlFeatures } from '../../common/constants/app';
import { MlLicense } from '../../common/license';
import { registerAnomalyDetectionAgentBuilder } from '../agent_builder/register_anomaly_detection';
import { createInProcessMlCapabilitiesResolver } from '../lib/capabilities/resolve_ml_capabilities_in_process';
import { createSnapshotModuleFiles } from '../models/data_recognizer/module_files';
import type { DataRecognizerModuleSnapshot } from '../models/data_recognizer/module_files';
import type { MlDataViews } from '../shared_services/shared_services';
import { getMlSavedObjectTypes } from '../saved_objects';

/** The id of the settings the plugin sends a task process to register its agent builder skill. */
export const ML_AGENT_BUILDER_SETTINGS_ID = 'mlAgentBuilder';

/** What ML sends a task process for its agent builder registrations (decided in Kibana). */
export interface MlAgentBuilderSettings {
  /** The features this Kibana has enabled (`xpack.ml.ad`, `dfa` and `nlp`). */
  enabledFeatures: MlFeatures;
  /** `xpack.ml.compatibleModuleType`. */
  compatibleModuleType: CompatibleModule | null;
  /** Whether the spaces plugin is enabled. */
  spacesEnabled: boolean;
  cpsEnabled: boolean;
  moduleFiles: DataRecognizerModuleSnapshot;
}

/**
 * What the ML plugin registers with agent builder, in the task process of the workflow task types:
 * the anomaly detection skill (and its tools) and the three anomaly attachment types, which `setup()`
 * registers with the same function. Its services are built from the host of the process, as the ML
 * rule types' are (`createMlRunServices`): the ML client over the user of the request, the saved
 * object service over the internal repository, the license, and the capabilities of the request
 * resolved from its privileges (there is no Core capabilities service in a process). Without the
 * setting the plugin or its anomaly detection feature is not enabled in this Kibana, and nothing is
 * registered.
 */
export const contribution: AgentBuilderContribution = {
  declares: {
    savedObjectTypes: getMlSavedObjectTypes(),
    settings: [ML_AGENT_BUILDER_SETTINGS_ID],
  },
  register: (agentBuilder, { host, settings, isServerless, services }) => {
    const sent = settings[ML_AGENT_BUILDER_SETTINGS_ID] as MlAgentBuilderSettings | undefined;
    if (!sent?.enabledFeatures) return;
    // What the registrations read of the host is read when a tool runs, not while registering (the
    // license is the exception: the tools check it synchronously, so it is subscribed to now).
    const taskHost = host as TaskHost;
    const { licensing } = taskHost;
    const getAuthorization = () => {
      const security = taskHost.plugins?.security as SecurityTaskPluginStart | undefined;
      if (!security) throw new Error('ML execution requires the native Security service');
      return security.authz;
    };
    const authorization: MlAuthorizationService = {
      get actions() {
        return getAuthorization().actions;
      },
      get mode() {
        return getAuthorization().mode;
      },
      checkPrivilegesWithRequest: (request) =>
        getAuthorization().checkPrivilegesWithRequest(request),
      checkPrivilegesDynamicallyWithRequest: (request) =>
        getAuthorization().checkPrivilegesDynamicallyWithRequest(request),
    };
    const mlLicense = new MlLicense();
    if (licensing) mlLicense.setup(licensing.license$);
    taskHost.onRunEnd?.(async () => mlLicense.unsubscribe());
    registerAnomalyDetectionAgentBuilder({
      agentBuilder,
      resolveMlCapabilities: createInProcessMlCapabilitiesResolver({
        authorization,
        license$: defer(() => {
          if (!taskHost.licensing)
            throw new Error('The workflows task module did not get the license');
          return taskHost.licensing.license$;
        }),
        enabledFeatures: sent.enabledFeatures,
        isServerless,
      }),
      authorization,
      mlLicense,
      enabledFeatures: sent.enabledFeatures,
      mlClientFactoryDeps: {
        getInternalSavedObjectsClient: () =>
          new SavedObjectsClient(taskHost.savedObjects.createInternalRepository()),
        getAuditService: () => taskHost.security.audit as CoreAuditService,
        spacesEnabled: sent.spacesEnabled,
        authorization,
        mlLicense,
        serverless: { isServerless, cpsEnabled: sent.cpsEnabled },
        // A task process has no startup to wait for: the job saved objects are Kibana's to initialize.
        isMlReady: () => Promise.resolve(),
        getDataViews: () => services.getService<MlDataViews>('dataViews'),
        compatibleModuleType: sent.compatibleModuleType,
        moduleFiles: createSnapshotModuleFiles(sent.moduleFiles),
      },
    });
  },
};
