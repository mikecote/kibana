/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ITelemetryEventsSender } from './sender';

/** The kind of the telemetry channel a task process reports security telemetry on. */
export const RULE_RUN_TELEMETRY_KIND = 'securitySolution.telemetry';

/** What a rule run calls on the telemetry sender: it only queues events to send. */
export type RuleRunTelemetrySender = Pick<ITelemetryEventsSender, 'sendAsync'>;

/** The methods a task process may call on the sender of Kibana, with serializable arguments. */
const RULE_RUN_TELEMETRY_METHODS = ['sendAsync'] as const;
type RuleRunTelemetryMethod = (typeof RULE_RUN_TELEMETRY_METHODS)[number];

export interface RuleRunTelemetryPayload {
  method: RuleRunTelemetryMethod;
  args: Parameters<RuleRunTelemetrySender[RuleRunTelemetryMethod]>;
}

/**
 * The sender a task process hands to a rule run: it never sends, it reports each call with the run,
 * and Kibana replays it on its own sender (see `createRuleRunTelemetrySink`). The events must be
 * serializable, which the documents of an alert are.
 */
export const createRuleRunTelemetrySender = (
  report: (kind: string, payload: unknown) => void
): RuleRunTelemetrySender => ({
  sendAsync: (...args) =>
    report(RULE_RUN_TELEMETRY_KIND, { method: 'sendAsync', args } as RuleRunTelemetryPayload),
});

/**
 * Kibana's end of `createRuleRunTelemetrySender`: replays what a task process reported on the
 * sender of the plugin, which is the only one that can send.
 */
export const createRuleRunTelemetrySink =
  (getSender: () => RuleRunTelemetrySender) => (payload: unknown) => {
    const { method, args } = payload as RuleRunTelemetryPayload;
    if (!RULE_RUN_TELEMETRY_METHODS.includes(method)) {
      throw new Error(`A task process cannot call "${String(method)}" on the telemetry sender`);
    }
    getSender()[method](...args);
  };
