/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { ServiceIdentifier } from 'inversify';
import type { AttachmentTypeDefinition } from '@kbn/agent-builder-server/attachments';
import type { SmlTypeDefinition } from '@kbn/agent-builder-sml-plugin/server';
import { createActionPolicyAttachmentType } from './attachments/action_policy_attachment_type';
import { createAlertAttachmentType } from './attachments/alert_attachment_type';
import { createRuleAttachmentType } from './attachments/rule_attachment_type';
import { createActionPolicySmlType } from './sml/action_policy_sml_type';
import { createRuleSmlType } from './sml/rule_sml_type';
import { ActionPolicyClient } from '../lib/action_policy_client';
import { EpisodesClient } from '../lib/episodes_client';
import { PrivilegeChecker } from '../lib/services/privilege_checker/privilege_checker';
import { RulesClient } from '../lib/rules_client';
import type { LoggerServiceContract } from '../lib/services/logger_service/logger_service';

export type ResolveAlertingV2Service = <T>(
  request: KibanaRequest,
  token: ServiceIdentifier<T>
) => T;

/** Creates the attachment definitions used by both plugin and task-process registration. */
export const createAlertingV2AttachmentTypes = ({
  logger,
  resolve,
}: {
  logger: LoggerServiceContract;
  resolve: ResolveAlertingV2Service;
}): AttachmentTypeDefinition[] => [
  createRuleAttachmentType({
    logger,
    getRulesClient: ({ request }) => resolve(request, RulesClient),
  }) as AttachmentTypeDefinition,
  createActionPolicyAttachmentType({
    logger,
    getActionPolicyClient: ({ request }) => resolve(request, ActionPolicyClient),
  }) as AttachmentTypeDefinition,
  createAlertAttachmentType({
    logger,
    getEpisodesClient: ({ request }) => resolve(request, EpisodesClient),
    getRulesClient: ({ request }) => resolve(request, RulesClient),
    getPrivilegeChecker: ({ request }) => resolve(request, PrivilegeChecker),
  }) as AttachmentTypeDefinition,
];

/** Creates SML definitions whose clients and enabled setting are resolved for each operation. */
export const createAlertingV2SmlTypes = ({
  resolve,
  getIsAlertingV2Enabled,
}: {
  resolve: ResolveAlertingV2Service;
  getIsAlertingV2Enabled: () => Promise<boolean>;
}): SmlTypeDefinition[] => [
  createRuleSmlType({
    getScopedRulesClient: (request) => resolve(request, RulesClient),
    getIsAlertingV2Enabled,
  }),
  createActionPolicySmlType({
    getScopedActionPolicyClient: (request) => resolve(request, ActionPolicyClient),
    getIsAlertingV2Enabled,
  }),
];
