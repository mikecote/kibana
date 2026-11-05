/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { TelemetryChannel } from './types';
import {
  createRuleRunTelemetrySender,
  createRuleRunTelemetrySink,
  RULE_RUN_TELEMETRY_KIND,
} from './rule_run_telemetry_sender';

describe('rule run telemetry sender', () => {
  it('reports each call with the run instead of sending', () => {
    const report = jest.fn();
    const events = [{ id: 'alert-1' }];

    createRuleRunTelemetrySender(report).sendAsync(TelemetryChannel.DETECTION_ALERTS, events);

    expect(report).toHaveBeenCalledWith(RULE_RUN_TELEMETRY_KIND, {
      method: 'sendAsync',
      args: [TelemetryChannel.DETECTION_ALERTS, events],
    });
  });

  it('replays the reported calls on the sender of Kibana', () => {
    const sender = { sendAsync: jest.fn() };
    const report = jest.fn();
    createRuleRunTelemetrySender(report).sendAsync(TelemetryChannel.ENDPOINT_ALERTS, [{ a: 1 }]);

    createRuleRunTelemetrySink(() => sender)(report.mock.calls[0][1]);

    expect(sender.sendAsync).toHaveBeenCalledWith(TelemetryChannel.ENDPOINT_ALERTS, [{ a: 1 }]);
  });

  it('only replays the methods a rule run uses', () => {
    const sender = { sendAsync: jest.fn(), stop: jest.fn() };

    expect(() => createRuleRunTelemetrySink(() => sender)({ method: 'stop', args: [] })).toThrow(
      'cannot call "stop"'
    );
    expect(sender.stop).not.toHaveBeenCalled();
  });
});
