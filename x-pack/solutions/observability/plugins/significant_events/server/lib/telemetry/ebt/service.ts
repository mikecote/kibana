/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AnalyticsServiceSetup } from '@kbn/core-analytics-server';
import {
  agentBuilderKnowledgeIndicatorCreatedEventType,
  agentToolEventCreateEventType,
  agentToolEventInvestigationAttachEventType,
  agentToolEventStatusUpdateEventType,
  agentToolKiIdentificationStartedEventType,
  codeAnalysisGroundingEventType,
  detectionScanEventType,
  discoveryTriggeredEventType,
  knowledgeIndicatorEventsGeneratedEventType,
  knowledgeIndicatorFeaturesIdentifiedEventType,
  onboardingScheduledEventType,
  agentToolEventWriteEventType,
  agentToolEventSearchEventType,
} from './events';
import { EbtTelemetryClient } from './client';

export const registerSignificantEventsAnalyticsEventTypes = (
  analytics: Pick<AnalyticsServiceSetup, 'registerEventType'>
): void => {
  analytics.registerEventType(knowledgeIndicatorEventsGeneratedEventType);
  analytics.registerEventType(knowledgeIndicatorFeaturesIdentifiedEventType);
  analytics.registerEventType(agentBuilderKnowledgeIndicatorCreatedEventType);
  analytics.registerEventType(agentToolKiIdentificationStartedEventType);
  analytics.registerEventType(agentToolEventCreateEventType);
  analytics.registerEventType(agentToolEventStatusUpdateEventType);
  analytics.registerEventType(agentToolEventWriteEventType);
  analytics.registerEventType(agentToolEventSearchEventType);
  analytics.registerEventType(agentToolEventInvestigationAttachEventType);
  analytics.registerEventType(codeAnalysisGroundingEventType);
  analytics.registerEventType(discoveryTriggeredEventType);
  analytics.registerEventType(detectionScanEventType);
  analytics.registerEventType(onboardingScheduledEventType);
};

export class EbtTelemetryService {
  private analytics?: AnalyticsServiceSetup;

  constructor() {}

  public setup(analytics: AnalyticsServiceSetup) {
    this.analytics = analytics;
    registerSignificantEventsAnalyticsEventTypes(analytics);
  }

  public getClient() {
    if (!this.analytics) {
      throw new Error('Analytics service is not available.');
    }
    return new EbtTelemetryClient(this.analytics);
  }
}
