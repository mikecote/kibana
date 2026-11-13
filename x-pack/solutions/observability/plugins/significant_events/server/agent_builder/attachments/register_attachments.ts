/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AgentBuilderPluginSetup } from '@kbn/agent-builder-server';
import type { Logger } from '@kbn/core/server';
import type { SignificantEventsAuthorizationServices } from '../../run_services/authorization';
import type { GetScopedClients } from '../../routes/types';
import { createSignificantEventAttachmentType } from './significant_event_attachment_type';
import { createSignificantEventFeatureAttachmentType } from './feature_attachment_type';
import { createSignificantEventDetectionAttachmentType } from './detection_attachment_type';

export const registerAgentBuilderAttachments = ({
  agentBuilder,
  getScopedClients,
  server,
  attachmentTypeIds,
  onRegistered,
  logger,
}: {
  agentBuilder: AgentBuilderPluginSetup;
  getScopedClients: GetScopedClients;
  server: SignificantEventsAuthorizationServices;
  attachmentTypeIds?: readonly string[];
  onRegistered?: (id: string) => void;
  logger: Logger;
}): void => {
  const attachments = [
    createSignificantEventAttachmentType({
      logger: logger.get('significant_event_attachment'),
      getScopedClients,
      server,
    }),
    createSignificantEventFeatureAttachmentType({
      logger: logger.get('significant_event_feature_attachment'),
      getScopedClients,
      server,
    }),
    createSignificantEventDetectionAttachmentType({
      logger: logger.get('significant_event_detection_attachment'),
      getScopedClients,
      server,
    }),
  ];
  for (const attachment of attachments) {
    if (attachmentTypeIds && !attachmentTypeIds.includes(attachment.id)) continue;
    agentBuilder.attachments.registerType(
      attachment as Parameters<typeof agentBuilder.attachments.registerType>[0]
    );
    onRegistered?.(attachment.id);
  }
};
