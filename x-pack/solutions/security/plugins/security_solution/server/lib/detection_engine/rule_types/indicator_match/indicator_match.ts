/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  RuleRunLicensing,
  WrapSuppressedHits,
  SecuritySharedParams,
  SecurityRuleServices,
} from '../types';

import type { RuleRunTelemetrySender } from '../../../telemetry/rule_run_telemetry_sender';
import { createThreatSignals } from './threat_mapping/create_threat_signals';
import type { ThreatRuleParams } from '../../rule_schema';
import { withSecuritySpan } from '../../../../utils/with_security_span';
import type { ScheduleNotificationResponseActionsService } from '../../rule_response_actions/schedule_notification_response_actions';

export const indicatorMatchExecutor = async ({
  sharedParams,
  services,
  eventsTelemetry,
  wrapSuppressedHits,
  licensing,
  scheduleNotificationResponseActionsService,
}: {
  sharedParams: SecuritySharedParams<ThreatRuleParams>;
  services: SecurityRuleServices;
  eventsTelemetry: RuleRunTelemetrySender | undefined;
  wrapSuppressedHits: WrapSuppressedHits;
  licensing: RuleRunLicensing;
  scheduleNotificationResponseActionsService: ScheduleNotificationResponseActionsService;
}) => {
  return withSecuritySpan('indicatorMatchExecutor', async () => {
    return createThreatSignals({
      sharedParams,
      eventsTelemetry,
      services,
      wrapSuppressedHits,
      licensing,
      scheduleNotificationResponseActionsService,
    });
  });
};
