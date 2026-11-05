/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { firstValueFrom } from 'rxjs';
import { collectTelemetry, createHostFeatureFlags, createHostTelemetry } from './telemetry';

describe('task process telemetry', () => {
  const host = createHostTelemetry();

  it('returns what a run reported, by channel', async () => {
    const { value, telemetry } = await collectTelemetry(async () => {
      host.analytics.reportEvent('an_event', { n: 1 });
      host.telemetry.report('security', { channel: 'alerts' });
      host.featureUsage.notifyUsage('ML', new Date('2026-01-01T00:00:00.000Z'));
      return 'done';
    });

    expect(value).toBe('done');
    expect(telemetry).toEqual({
      events: [{ eventType: 'an_event', data: { n: 1 } }],
      featureUsages: [{ featureName: 'ML', lastUsed: '2026-01-01T00:00:00.000Z' }],
      custom: [{ kind: 'security', payload: { channel: 'alerts' } }],
    });
  });

  it('keeps the reports of runs that overlap apart', async () => {
    const run = (name: string, delay: number) =>
      collectTelemetry(async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        host.analytics.reportEvent(name, {});
      });

    const [first, second] = await Promise.all([run('first', 20), run('second', 1)]);

    expect(first.telemetry.events.map((event) => event.eventType)).toEqual(['first']);
    expect(second.telemetry.events.map((event) => event.eventType)).toEqual(['second']);
  });

  it('returns what a run reported before it threw', async () => {
    const failure = new Error('boom');
    const { error, telemetry } = await collectTelemetry(async () => {
      host.analytics.reportEvent('before_failure', {});
      throw failure;
    });

    expect(error).toBe(failure);
    expect(telemetry.events).toHaveLength(1);
  });

  it('drops a report made outside any run', () => {
    expect(() => host.analytics.reportEvent('orphan', {})).not.toThrow();
  });

  describe('feature flags', () => {
    const flags = createHostFeatureFlags();

    it('answers with what Kibana evaluated for the run that asks', async () => {
      const { value } = await collectTelemetry(
        async () => firstValueFrom(flags.getBooleanValue$('a.flag', false)),
        { featureFlags: { 'a.flag': true } }
      );

      expect(value).toBe(true);
    });

    it('answers with the fallback for a flag the run was not given, or of another type', async () => {
      const { value } = await collectTelemetry(
        async () => [
          await firstValueFrom(flags.getBooleanValue$('missing', true)),
          await firstValueFrom(flags.getStringValue$('a.flag', 'fallback')),
        ],
        { featureFlags: { 'a.flag': true } }
      );

      expect(value).toEqual([true, 'fallback']);
    });
  });
});
