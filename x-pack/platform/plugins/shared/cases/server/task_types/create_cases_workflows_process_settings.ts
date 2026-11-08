/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { NotificationsPluginStart } from '@kbn/notifications-plugin/server';
import type { CasesFeatures } from '../client/types';
import type { ConfigType } from '../config';
import type { CasesEventBus } from '../events/event_bus';
import type { CasesWorkflowsProcessSettings } from './cases_task_process_settings';

/**
 * What Kibana sends the task process of the workflow task types for the cases steps: the config the
 * client reads and what it knows of the other plugins (features, notifications, bus listeners,
 * close reason validators) that the process cannot rebuild. Call it when a process starts.
 */
export const createCasesWorkflowsProcessSettings = ({
  config,
  spacesEnabled,
  features,
  notifications,
  casesEventBus,
  closeReasonOwners,
  attachmentTypeIds,
}: {
  config: Pick<
    ConfigType,
    'templates' | 'assigneeIdentity' | 'attachments' | 'analyticsV2' | 'files'
  >;
  spacesEnabled: boolean;
  features: CasesFeatures;
  notifications: Pick<NotificationsPluginStart, 'isEmailServiceAvailable'>;
  casesEventBus: Pick<CasesEventBus, 'hasAlertStatusChangedListeners'>;
  closeReasonOwners: string[];
  attachmentTypeIds: string[];
}): CasesWorkflowsProcessSettings => ({
  config: {
    templates: { enabled: config.templates.enabled },
    assigneeIdentity: { enabled: config.assigneeIdentity.enabled },
    attachments: { enabled: config.attachments.enabled },
    analyticsV2: { enabled: config.analyticsV2.enabled },
    files: { ...config.files, allowedMimeTypes: [...config.files.allowedMimeTypes] },
  },
  spacesEnabled,
  featureCaseOwners: features
    .getKibanaFeatures()
    .flatMap(({ id, cases }) => (cases?.length ? [{ id, cases: [...cases] }] : [])),
  isEmailServiceAvailable: notifications.isEmailServiceAvailable(),
  hasAlertStatusChangedListeners: casesEventBus.hasAlertStatusChangedListeners(),
  closeReasonOwners,
  attachmentTypeIds: [...attachmentTypeIds],
});
