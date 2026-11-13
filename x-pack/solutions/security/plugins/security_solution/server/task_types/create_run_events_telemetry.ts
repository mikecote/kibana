/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { TaskHost } from '@kbn/task-manager-plugin/server/task_type_module';
import { APP_ID } from '../../common/constants';
import type { SecurityRuleRunConfig } from '../config';
import { createRuleRunTelemetrySender } from '../lib/telemetry/rule_run_events_sender';
import type { RuleRunTelemetrySender } from '../lib/telemetry/rule_run_events_sender';

/**
 * The sender of the events of a run, which is one per process: it queues what runs send, and the
 * process flushes the queue before it answers each run. Built when the first run sends, from what
 * Kibana said of its telemetry; without it (no telemetry plugin) nothing is sent, as in Kibana.
 */
export const createRunEventsTelemetry = (
  host: TaskHost,
  config: SecurityRuleRunConfig,
  logger: Logger
): RuleRunTelemetrySender | undefined => {
  if (!config.ruleRunTelemetry) return undefined;
  const settings = config.ruleRunTelemetry;
  let created: ReturnType<typeof createRuleRunTelemetrySender> | undefined;
  return {
    sendAsync: (channel, events) => {
      if (!created) {
        created = createRuleRunTelemetrySender({
          logger,
          settings,
          usageCounter: host.usageCounters?.getUsageCounter(APP_ID),
          analytics: host.analytics,
        });
        host.onRunEnd?.(created.flush);
      }
      created.sender.sendAsync(channel, events);
    },
  };
};
