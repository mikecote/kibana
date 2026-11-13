/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ServerlessProjectType } from '../../common/constants/types';
import type { CasesClientConfig, ConfigType } from '../config';

/** The validated Cases configuration and registry metadata captured for each process dispatch. */
export interface CasesWorkflowsProcessSettings {
  /** The part of the validated config that the cases client reads, and the analytics v2 switch. */
  config: CasesClientConfig & Pick<ConfigType, 'files'> & { analyticsV2: { enabled: boolean } };
  /** Whether the spaces plugin is enabled: the disabled features of the space limit the owners. */
  spacesEnabled: boolean;
  attachmentTypeIds: string[];
  /** The features that grant access to cases, with the owners each grants (the features registry). */
  featureCaseOwners: Array<{ id: string; cases: string[] }>;
  /** Whether the notifications plugin can send the assignees an email (a connector is configured). */
  isEmailServiceAvailable: boolean;
  emailConnectorId?: string;
  /**
   * Whether a plugin listens to the alert status changes of the cases event bus (the security
   * solution forwards them to its workflow triggers), restored through the owning plugin contributions.
   */
  hasAlertStatusChangedListeners: boolean;
  /** The owners that registered a validator of the close reasons, restored through the owning plugin contributions. */
  closeReasonOwners: string[];
}

/** What cases sends to a task process, as the settings of `cases`. */
export interface CasesTaskProcessSettings {
  /** What a rule run needs of cases. */
  serverlessProjectType?: ServerlessProjectType;
  isCasesAttachmentsEnabled: boolean;
  isTemplatesEnabled: boolean;
  /** What the workflow steps need of cases; absent until Kibana has started. */
  workflows?: CasesWorkflowsProcessSettings;
}
