/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import { SECURITY_EXTENSION_ID } from '@kbn/core-saved-objects-server';
import { DEFAULT_SPACE_ID } from '@kbn/core-spaces-common';
import { KibanaFeature } from '@kbn/features-plugin/common';
import type { SecurityTaskPluginStart } from '@kbn/security-plugin/server/task_plugin';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import type { WorkflowStepsContributionServices } from '@kbn/workflows-extensions/server';
import type { PluginStartContract as ActionsStart } from '@kbn/actions-plugin/server';
import { AlertingAuthorization } from '../authorization';
import { LicenseState } from '../lib/license_state';
import { RULE_SAVED_OBJECT_TYPE } from '../saved_objects';
import { createRulesReadClient } from '../rules_client/create_rules_read_client';
import type { RulesReadClient } from '../rules_client/create_rules_read_client';
import {
  ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID,
  createAlertingAuthorizationRegistry,
} from './alerting_authorization_task_process_settings';
import type { AlertingAuthorizationTaskProcessSettings } from './alerting_authorization_task_process_settings';
import { createRulesReadRegistry } from './create_rules_read_registry';
import { RULE_READ_CONTRIBUTIONS_KEY, RULE_READ_SETTINGS_ID } from './rule_read_contribution';
import type { RuleReadContribution, RuleReadSettings } from './rule_read_contribution';

export interface WorkflowRulesReadServices {
  getRulesClientWithRequest: (request: KibanaRequest) => Promise<RulesReadClient>;
}

/** Builds real scoped rule readers from this execution's license, security and registration state. */
export const createWorkflowRulesReadServices = ({
  host,
  services,
  registerCleanup,
}: {
  host: TaskHost;
  services: WorkflowStepsContributionServices;
  registerCleanup: (cleanup: () => void) => void;
}): WorkflowRulesReadServices => {
  const authorizationSettings = host.settings?.[ALERTING_AUTHORIZATION_TASK_PROCESS_SETTINGS_ID] as
    | AlertingAuthorizationTaskProcessSettings
    | undefined;
  const readSettings = host.settings?.[RULE_READ_SETTINGS_ID] as RuleReadSettings | undefined;
  if (!authorizationSettings || !readSettings || !host.licensing)
    throw new Error('Native rule readers require Main registration metadata and licensing');
  const security = host.plugins?.security as SecurityTaskPluginStart | undefined;
  if (authorizationSettings.securityEnabled && !security)
    throw new Error('Native rule readers require Security services');
  const spaces = authorizationSettings.spacesEnabled
    ? services.getService<SpacesPluginStart>('spaces')
    : undefined;
  const features = authorizationSettings.features.map((feature) => new KibanaFeature(feature));
  const authorizationRegistry = createAlertingAuthorizationRegistry(authorizationSettings);
  const licenseState = new LicenseState(host.licensing.license$);
  registerCleanup(() => licenseState.clean());
  if (host.licensing.featureUsage)
    licenseState.setNotifyUsage(host.licensing.featureUsage.notifyUsage);
  const ruleTypeRegistry = createRulesReadRegistry({
    settings: readSettings,
    contributions: (host.contributions?.[RULE_READ_CONTRIBUTIONS_KEY] ??
      []) as RuleReadContribution[],
    logger: host.logger,
    licenseState,
  });
  return {
    getRulesClientWithRequest: async (request) => {
      const spaceId = spaces?.spacesService.getSpaceId(request) ?? DEFAULT_SPACE_ID;
      const authorization = await AlertingAuthorization.create({
        request,
        ruleTypeRegistry: authorizationRegistry,
        features: { getKibanaFeatures: () => features },
        authorization: authorizationSettings.securityEnabled ? security?.authz : undefined,
        getSpace: async (scopedRequest) => spaces?.spacesService.getActiveSpace(scopedRequest),
        getSpaceId: () => spaceId,
      });
      const actions = services.getService<Pick<ActionsStart, 'isSystemActionConnector'>>('actions');
      return createRulesReadClient({
        authorization,
        ruleTypeRegistry,
        logger: host.logger,
        auditLogger: authorizationSettings.securityEnabled
          ? security?.audit.asScoped(request)
          : undefined,
        unsecuredSavedObjectsClient: host.savedObjects
          .getScopedClient(request, {
            excludedExtensions: [SECURITY_EXTENSION_ID],
            includedHiddenTypes: [RULE_SAVED_OBJECT_TYPE],
          })
          .asScopedToNamespace(spaceId),
        isSystemAction: (id) => actions.isSystemActionConnector(id),
      });
    },
  };
};
